import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { graphicsExpression } from './fixtures/graphics-probe.mjs';

assert.equal(process.platform, 'win32');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const original = resolve(`release/${metadata.version}/win-unpacked`);
if (await readFile(join(original, 'resources/system-graphics.json')).catch(() => null)) {
  process.stdout.write(execFileSync(process.execPath, ['scripts/verify-release-package.mjs', original], { windowsHide: true, encoding: 'utf8' }));
  process.exit(0);
}
const scratchRoot = resolve('.tmp');
await mkdir(scratchRoot, { recursive: true });
const work = await mkdtemp(join(scratchRoot, 'd3dcompiler-compatibility-'));
assert.equal(dirname(work), scratchRoot);
const application = join(work, 'application');
const compilerPath = join(application, 'd3dcompiler_47.dll');
const native = join(work, 'D3DCompilerDiagnostic.exe');
const systemCompiler = join(process.env.SystemRoot, 'System32/D3DCompiler_47.dll');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const originalHash = await hash(join(original, 'd3dcompiler_47.dll'));
await cp(original, application, { recursive: true, errorOnExist: true, force: false });
execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + native, resolve('scripts/fixtures/d3dcompiler-diagnostic.cs')],
  { windowsHide: true, encoding: 'utf8' });

// Shared with the mandatory system-runtime package check.
const hook = `
  const graphics=await evaluate(${JSON.stringify(graphicsExpression)});
  const compilerModules=JSON.parse(execFileSync(${JSON.stringify(native)},['modules',executable,String(child.pid)],{windowsHide:true,encoding:'utf8'}));
  await writeFile(join(evidence,'graphics.json'),JSON.stringify({graphics,compilerModules},null,2));
`;
let source = await readFile('scripts/verify-release-package.mjs', 'utf8');
assert.equal(source.split("  const screenshot = await call('Page.captureScreenshot'").length, 2);
source = source.replace("import { spawn } from 'node:child_process';", "import { spawn, execFileSync } from 'node:child_process';")
  .replace("  const screenshot = await call('Page.captureScreenshot'", hook + "  const screenshot = await call('Page.captureScreenshot'");
const runner = join(work, 'probe-runner.mjs');
await writeFile(runner, source);
const cases = [];
for (const variant of ['bundled-original', 'system-copy', 'system-resolved']) {
  assert.equal(dirname(compilerPath), application);
  let shader;
  if (variant === 'system-copy') await copyFile(systemCompiler, compilerPath);
  if (variant === 'system-resolved') await unlink(compilerPath);
  shader=JSON.parse(execFileSync(native,['shader',variant==='system-resolved'?systemCompiler:compilerPath],{windowsHide:true,encoding:'utf8'}));
  const output=execFileSync(process.execPath,[runner,application],{windowsHide:true,encoding:'utf8',timeout:90000,stdio:['ignore','pipe','pipe']});
  const release=JSON.parse(output);
  const graphics=JSON.parse(await readFile(join(release.evidence,'graphics.json'),'utf8'));
  assert.equal(graphics.graphics.canvas2d.passed,true);
  for(const context of graphics.graphics.webgl)if(context.supported)assert.equal(context.shaderDrawPassed,true);
  const result={variant,compilerPresent:variant!=='system-resolved',compilerSha256:variant==='system-resolved'?null:await hash(compilerPath),
    shader,graphics,releaseReport:join(release.evidence,'report.json'),screenshot:join(release.evidence,'packaged-activation.png'),status:'pass'};
  cases.push(result);
  await writeFile(join(work,variant+'.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({variant,status:'pass',renderers:graphics.graphics.webgl.map(context=>context.renderer??'unsupported'),
    loadedCompilers:graphics.compilerModules.processes.flatMap(process=>process.compilers.map(compiler=>compiler.path))}));
}
await copyFile(join(original,'d3dcompiler_47.dll'),compilerPath);
assert.equal(await hash(join(original,'d3dcompiler_47.dll')),originalHash);
const report={status:'pass',version:metadata.version,work,sourcePackageUntouched:true,actualUserDataUsed:false,productionServerRequests:0,
  securitySoftwareSettingsChanged:false,windowsFilesChanged:false,antivirusAcceptanceTested:false,cases};
await writeFile(join(work,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:'pass',report:join(work,'report.json'),cases:cases.length}));
