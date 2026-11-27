import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { lstat, mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { extractFile, uncache } from '@electron/asar';
import { PROJECT, checkedBackend, checkedFeed, checkedVersion, inside, laneForTarget, ordinary, parseArguments } from './business-package-common.mjs';
import { buildBusinessPayload } from './build-business-payload.mjs';
import { stageBusinessShell } from './stage-business-shell.mjs';
import { stageBusinessShellDeb } from './stage-business-shell-deb.mjs';
import { buildBusinessShellUniversal } from './build-business-shell-universal.mjs';

// Local, offline artifact construction only. Publication uses the normal admin API.
const args = parseArguments(process.argv.slice(2), ['version','min-shell-version','backend-origin','backend-revision','feed-base','expected-commit','output','python']);
const version = checkedVersion(args.version), minimum = checkedVersion(args['min-shell-version'], 'minimum shell version');
const compare = (a,b) => { for (let i=0;i<3;i++) { const n=Number(a.split('.')[i])-Number(b.split('.')[i]); if(n)return n; } return 0; };
assert(compare(version, minimum)>=0, 'Minimum shell cannot exceed the new shell version');
const backend = checkedBackend(args['backend-origin'], Number(args['backend-revision'])), feedBase = checkedFeed(args['feed-base']);
assert.equal(new URL(feedBase).origin, backend.origin, 'Use the same intranet backend/feed origin');
assert(!/(?:^|\.)aliyuncs\.com$/i.test(new URL(feedBase).hostname) && new URL(feedBase).hostname!=='193.112.96.168', 'Refusing Shenzhen/OSS release configuration');
const git = (...values) => execFileSync('git', values, { cwd:PROJECT,encoding:'utf8',windowsHide:true }).trim();
assert.equal(git('branch','--show-current'), 'codex/huizhou-intranet', 'Merge the Shenzhen source into the Huizhou branch before packaging');
const commit = git('rev-parse','HEAD');
assert.equal(args['expected-commit'], commit, 'Freeze the exact source commit');
assert.equal(git('status','--porcelain'), '', 'Commit source changes before packaging');
const output = resolve(PROJECT,args.output ?? join('release','huizhou-intranet-'+version));
assert(inside(output,join(PROJECT,'release')), 'Use a separate release directory');
assert(!await lstat(output).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),'Retain published artifacts and select a new output');
const disk=await statfs(PROJECT);assert(disk.bavail*disk.bsize>=4*1024**3,'At least4GiB free disk is required');
const embedded=(await readFile(join(PROJECT,'src/main/runtime.ts'),'utf8')).match(/const PRODUCT_PUBLIC_KEY = `([\s\S]*?)`;/)?.[1];
assert(embedded,'Missing product trust key');
assert.deepEqual(createPublicKey(embedded).export({type:'spki',format:'der'}),createPublicKey(await readFile(join(PROJECT,'private/license-public.pem'))).export({type:'spki',format:'der'}),'Do not replace the existing production trust key');
const targets = [
  {platform:'win32',arch:'x64',variant:'standard',electronMajor:44},
  {platform:'win32',arch:'x64',variant:'standard',electronMajor:22},
  {platform:'linux',arch:'x64',variant:'standard',electronMajor:44},
  {platform:'linux',arch:'arm64',variant:'standard',electronMajor:44},
  {platform:'linux',arch:'arm64',variant:'kirin990',electronMajor:44},
];
for(const target of targets) {
  const runtime=target.platform==='linux'?join(PROJECT,'.tmp/kylin-runtime/44.3.0',target.arch)
    :target.electronMajor===22?join(PROJECT,'.tmp/win7-runtime/22.3.27/x64'):join(PROJECT,'node_modules/electron/dist');
  await ordinary(runtime,true);
  assert.equal((await readFile(join(runtime,'version'),'utf8')).trim(),target.electronMajor===22?'22.3.27':'44.3.0');
}
async function run(values, extra={}) {
  await new Promise((done,reject)=>{
    const child=spawn(process.execPath,values,{cwd:PROJECT,windowsHide:true,stdio:'inherit',env:{...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY:'false',npm_config_offline:'true',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',
      HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',ALL_PROXY:'http://127.0.0.1:1',NO_PROXY:'',...extra}});
    child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error('Local build exited '+code)));
  });
}
await run(['scripts/build-huizhou-intranet.mjs']);
await run(['scripts/build-huizhou-intranet.mjs','--win7']);
for(const source of ['out-huizhou','out-huizhou-win7']) {
  const main=await readFile(join(PROJECT,source,'main/index.js'),'utf8');
  for(const marker of ['return_upload_outbox','/api/returns/batches','this.returnUploads = new ReturnUploadQueue']) assert(main.includes(marker),'Missing Huizhou JSON queue: '+marker);
  assert(!main.includes('process.env.DATA_FUSION_DEPLOYMENT'),'Deployment flag was not compiled');
}
await mkdir(output);
const stages=[], artifacts=[], hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const target of targets) {
  const payload=await buildBusinessPayload({projectRoot:PROJECT,version,minShellVersion:minimum,...target,
    source:target.electronMajor===22?'out-huizhou-win7':'out-huizhou',backendOrigin:backend.origin,backendRevision:backend.revision,
    outputRoot:relative(PROJECT,join(output,'business'))});
  assert.deepEqual(payload.metadata.backend,backend);assert.equal(payload.metadata.minShellVersion,minimum);
  const shell=await stageBusinessShell({projectRoot:PROJECT,payload:payload.receipt,shellVersion:version,deployment:'huizhou-intranet',feedBase,
    outputRoot:relative(PROJECT,join(output,'shell')),...(target.platform==='linux'?{electronDist:join(PROJECT,'.tmp/kylin-runtime/44.3.0',target.arch)}:{})});
  stages.push({target,lane:laneForTarget(target),payload:payload.receipt,shellStage:shell.receipt,shellOutput:shell.outputDirectory});
}
await writeFile(join(output,'stages.json'),JSON.stringify(stages,null,2)+'\n',{flag:'wx'});
for(const stage of stages) {
  const windows=stage.target.platform==='win32';
  await run(['node_modules/electron-builder/cli.js','--config',windows?'electron-builder.shell.cjs':'electron-builder.shell.linux.cjs',
    ...(windows?['--win','nsis','--x64']:['--linux','--'+stage.target.arch,'--dir'])],{DATA_FUSION_SHELL_STAGE:stage.shellStage});
  const unpacked=join(stage.shellOutput,windows?'win-unpacked':stage.target.arch==='arm64'?'linux-arm64-unpacked':'linux-unpacked');
  const archive=join(unpacked,'resources/app.asar');uncache(archive);
  const shell=JSON.parse(extractFile(archive,'shell.json'));
  assert.equal(shell.deployment,'huizhou-intranet');assert.equal(shell.feedBase,feedBase);
  assert.deepEqual(await readFile(join(unpacked,'resources/business/builtin.asar')),await readFile(JSON.parse(await readFile(stage.payload,'utf8')).file));
  const file=windows?join(stage.shellOutput,stage.target.electronMajor===22?`HuizhouDataFusion-Win7-Component-${version}-x64.exe`:`惠州数据融合助手-安装包-${version}-x64.exe`)
    :(await stageBusinessShellDeb({projectRoot:PROJECT,shellStage:stage.shellStage,python:args.python??'python'})).file;
  await ordinary(file);artifacts.push({target:stage.target,file});
}
const universal=await buildBusinessShellUniversal({projectRoot:PROJECT,version,deployment:'huizhou-intranet',
  modern:artifacts.find(x=>x.target.platform==='win32'&&x.target.electronMajor===44).file,
  legacy:artifacts.find(x=>x.target.platform==='win32'&&x.target.electronMajor===22).file,outputRoot:relative(PROJECT,join(output,'windows-universal'))});
artifacts.push({windowsUniversal:true,file:universal.file});
const files=[];
for(const stage of stages) {const p=JSON.parse(await readFile(stage.payload,'utf8'));files.push({role:'business',target:stage.target,file:relative(output,p.file).split(sep).join('/'),bytes:p.bytes,sha256:p.sha256});}
for(const item of artifacts) {const bytes=await readFile(item.file);files.push({role:'installer',target:item.target??null,windowsUniversal:!!item.windowsUniversal,file:relative(output,item.file).split(sep).join('/'),bytes:bytes.length,sha256:hash(bytes)});}
const manifest={schema:1,deployment:'huizhou-intranet',version,shellVersion:version,minShellVersion:minimum,backend,feedBase,businessCommit:commit,
  appId:'cn.zzkj.datafusion.huizhou.desktop',productName:'惠州数据融合助手',windowsExecutable:'HuizhouDataFusion.exe',
  profiles:{standard:'huizhou-data-fusion-desktop',legacyWindows:'huizhou-data-fusion-desktop-win7'},linuxPackage:'huizhou-data-fusion-desktop',linuxInstallPrefix:'/opt/huizhou-data-fusion',
  published:false,targetDeviceAcceptance:false,authenticode:'unsigned',files};
await writeFile(join(output,'delivery-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
await writeFile(join(output,'SHA256SUMS.txt'),files.map(x=>x.sha256+'  '+x.file).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({output,version,minShellVersion:minimum,businessChannels:5,installerChannels:4,published:false}));
