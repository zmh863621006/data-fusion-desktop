// Real Electron -> hidden PowerShell -> normal parent exit; no installer or user profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const work = await mkdtemp(join(tmpdir(), 'fusion-helper-lifetime-'));
const entry = join(work, 'parent.cjs'), marker = join(work, 'after-parent-exit.txt');
let child;
try {
  const program = '$ErrorActionPreference="Stop"; $p=[Diagnostics.Process]::GetProcessById([int]$env:FUSION_TEST_PARENT); $h=$p.Handle; [IO.File]::WriteAllText($env:FUSION_TEST_READY,"ready"); if(-not $p.WaitForExit(10000)){exit 9}; [IO.File]::WriteAllText($env:FUSION_TEST_AFTER,"survived-normal-parent-exit")';
  const programPath=join(work,'program.ps1'), hostPath=join(work,'TestUpdateHost.exe'), configPath=join(work,'configuration.json');
  await writeFile(programPath,program); await writeFile(configPath,'{}');
  execFileSync(join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo','/target:winexe','/platform:x64','/resource:'+programPath+',DataFusion.Update.Script','/out:'+hostPath,resolve('resources/windows-update-host.cs')],
    { windowsHide:true,encoding:'utf8' });
  await writeFile(entry, `
const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const child = spawn(${JSON.stringify(hostPath)}, [],
    { detached:true, windowsHide:true, stdio:'ignore', env:{...process.env,DATA_FUSION_UPDATE_CONFIG:${JSON.stringify(configPath)},FUSION_TEST_PARENT:String(process.pid),FUSION_TEST_READY:${JSON.stringify(join(work, 'ready.txt'))},FUSION_TEST_AFTER:${JSON.stringify(marker)}} });
  child.unref();
  for(let i=0;i<100;i++) { if(fs.existsSync(${JSON.stringify(join(work, 'ready.txt'))})) { app.quit(); return; } await new Promise(resolve=>setTimeout(resolve,50)); }
  console.error('Hidden PowerShell never became ready'); app.exit(7);
});`);
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(resolve('node_modules/electron/dist/electron.exe'), [entry], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', value => { output += value.toString().slice(-2000); }); child.stdout.resume();
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Disposable Electron parent did not exit')), 15000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0, output);
  for (let i=0;i<100;i++) { if (await stat(marker).catch(()=>null)) break; await new Promise(resolve=>setTimeout(resolve,50)); }
  assert.equal(await readFile(marker, 'utf8'), 'survived-normal-parent-exit');
  console.log(JSON.stringify({ status:'pass', realElectronParent:true, hiddenPowerShellActuallyExecuted:true,
    helperSurvivesNormalParentExit:true, guiHostOwnsHelper:true, forcedTermination:false, userDataChanged:false }));
} finally {
  assert.equal(dirname(resolve(work)),resolve(tmpdir())); assert(basename(work).startsWith('fusion-helper-lifetime-'));
  await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
