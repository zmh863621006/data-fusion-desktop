import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Six separate Electron lifetimes. Only loopback fixtures and a newly created temporary profile.
const directory = await mkdtemp(join(tmpdir(), 'fusion-recovery-smoke-'));
let mode = 'valid';
const server = createServer((request, response) => {
  if (request.url === '/check') {
    const authorized = request.headers.cookie?.includes('fixtureSid=fixture-cookie-secret') && request.headers.authorization === 'fixture-api-secret';
    response.statusCode = mode === 'offline' ? 503 : mode === 'expired' || !authorized ? 401 : 200;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ valid: response.statusCode === 200 })); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/login') {
    response.setHeader('Set-Cookie', 'fixtureSid=fixture-cookie-secret; HttpOnly; SameSite=Lax; Path=/');
    response.end('<script>localStorage.setItem("local-token","fixture-local-secret");sessionStorage.setItem("page-token","fixture-page-secret");location.replace("/home");</script>');
  } else if (!request.headers.cookie?.includes('fixtureSid=fixture-cookie-secret')) {
    response.statusCode = 401; response.end('fixture login required');
  } else response.end('<body>fixture home<script>document.body.dataset.ready=String(sessionStorage.getItem("page-token")==="fixture-page-secret");</script></body>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const phase of ['save', 'restore', 'offline', 'expired', 'save', 'logout', 'after-logout']) {
    mode = phase === 'offline' || phase === 'expired' ? phase : 'valid';
    const child = spawn(process.execPath, ['node_modules/electron/cli.js', '.tmp/smoke-session-recovery.cjs',
      `--profile=${directory}`, `--origin=${origin}`, `--phase=${phase}`], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    if (code !== 0 || !output.includes(`PASS recovery ${phase}`)) throw new Error(`Recovery fixture ${phase} failed: ${output}`);
    console.log(`PASS recovery ${phase}`);
    if (phase === 'save') {
      const encrypted = await readFile(join(directory, 'sessions.secure.json'), 'utf8');
      assert(!/fixture-(?:api|cookie|page)-secret/.test(encrypted), 'Vault must contain no plaintext fixture credentials');
    }
  }
} finally {
  server.close();
  if (dirname(resolve(directory)) === resolve(tmpdir()) && directory.startsWith(join(tmpdir(), 'fusion-recovery-smoke-'))) {
    await rm(directory, { recursive: true, force: true });
  }
}
