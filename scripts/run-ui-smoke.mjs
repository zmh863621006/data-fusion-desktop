import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Chromium keeps some SQLite caches locked until the entire Electron process
// exits. A parent process must own and clean the isolated test profile.
const targets = { desktop: '.tmp/smoke-ui-redesign.cjs', admin: '.tmp/smoke-admin-ui-redesign.cjs', oversize: '.tmp/smoke-oversize-v3.cjs', hrss: '.tmp/smoke-hrss.cjs', hazardous: '.tmp/smoke-hazardous.cjs', 'hrss-certificate': '.tmp/smoke-hrss-certificate.cjs', 'hrss-background-session': '.tmp/smoke-hrss-background-session.cjs' };
const target = targets[process.argv[2]];
assert(target, 'Choose desktop, admin or oversize smoke test');
const profile = await mkdtemp(join(tmpdir(), 'fusion-ui-runner-'));
let exitCode = 1;
try {
  if (process.argv[2] === 'hrss-background-session') execFileSync('python', [resolve('scripts/fixtures/create-hrss-native-cert.py'), profile], { windowsHide: true });
  const require = createRequire(import.meta.url);
  const environment = { ...process.env, DATA_FUSION_UI_TEST_PROFILE: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  const runtime = process.argv.includes('--legacy') ? resolve('.tmp/win7-runtime/22.3.27/x64/electron.exe') : require('electron');
  const child = spawn(runtime, [resolve(target)], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env: environment });
  const timeout = setTimeout(() => { console.error('UI test timed out'); child.kill(); }, 180_000);
  try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); }); }
  finally { clearTimeout(timeout); }
} finally {
  const absolute = resolve(profile);
  assert.equal(dirname(absolute), resolve(tmpdir()), 'Cleanup must stay in the OS temp directory');
  assert(basename(absolute).startsWith('fusion-ui-runner-'), 'Only the profile created by this runner may be removed');
  await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log('PASS: isolated UI test profile removed after Electron exit');
}
process.exitCode = exitCode;
