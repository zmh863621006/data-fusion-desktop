import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const source = process.argv.find((value) => value.startsWith('--source='))?.slice(9);
if (!source) throw new Error('Explicit --source vault path is required');
const profile = await mkdtemp(join(tmpdir(), 'fusion-session-diagnostic-'));
try {
  const child = spawn(process.execPath, ['node_modules/electron/cli.js', '.tmp/diagnose-saved-sessions.cjs',
    `--source=${resolve(source)}`, `--profile=${profile}`], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally { clearTimeout(timer); }
} finally {
  // Only the unique profile just created above, never the real vault or application profile.
  if (dirname(resolve(profile)) === resolve(tmpdir()) && profile.startsWith(join(tmpdir(), 'fusion-session-diagnostic-'))) {
    await rm(profile, { recursive: true, force: true });
  }
}
