import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve('.tmp/task-center-smoke-' + Date.now());
await mkdir(root, { recursive: true });
await build({ entryPoints: ['scripts/fixtures/batch-task-center-renderer.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: join(root, 'renderer.js'), jsx: 'automatic' });
await build({ entryPoints: ['scripts/smoke-batch-task-center.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(root, 'main.cjs') });
const globalStyles = await readFile('src/renderer/src/styles.css', 'utf8');
await writeFile(join(root, 'global.css'), globalStyles);
await writeFile(join(root, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="global.css"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
const env = { ...process.env, TASK_CENTER_SMOKE_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), [join(root, 'main.cjs')], { env, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => { console.error('Batch task centre UI timed out'); child.kill(); }, 60_000);
try { process.exitCode = await new Promise((done, reject) => { child.once('exit', code => done(code ?? 1)); child.once('error', reject); }); }
finally { clearTimeout(timer); }
