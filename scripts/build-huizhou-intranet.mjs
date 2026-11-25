import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.slice(2).some(value => value !== '--win7')) throw Error('Only --win7 is supported');
const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js');
const legacy = process.argv.includes('--win7');
const child = spawn(process.execPath, [cli, 'build', ...(legacy ? ['--config', 'electron.vite.win7.config.ts'] : [])], {
  cwd: root, env: { ...process.env, DATA_FUSION_DEPLOYMENT: 'huizhou-intranet' }, windowsHide: true, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
