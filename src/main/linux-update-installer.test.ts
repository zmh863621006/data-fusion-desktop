import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { prepareLinuxUpdate, waitForDesktopInstaller } from './linux-update-installer';
import type { UpdateArtifact } from '../core/updater/service';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fusion-linux-update-'))); directories.push(root);
  const file = join(root, '下载的安装包 [1].deb'), bytes = Buffer.from('fixture DEB bytes');
  await writeFile(file, bytes);
  const artifact: UpdateArtifact = { version: '1.0.22', url: 'https://updates.test/app.deb', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), platform: 'linux', arch: 'x64', installer: 'deb' };
  const options = { installerPath: file, updatesDirectory: root, artifact, target: { platform: 'linux', arch: 'x64' } as const, platform: 'linux' };
  const dependencies = { inspect: vi.fn(async () => 'Package: data-fusion-desktop\nVersion: 1.0.22\nArchitecture: amd64\n'), open: vi.fn(async () => {}) };
  return { options, dependencies, file };
}
it('opens only a verified matching DEB on explicit handoff and rechecks after preparation', async () => {
  const f = await fixture(); const prepared = await prepareLinuxUpdate(f.options, f.dependencies);
  expect(f.dependencies.open).not.toHaveBeenCalled(); await prepared.open();
  expect(f.dependencies.open).toHaveBeenCalledExactlyOnceWith(f.file); expect(f.dependencies.inspect).toHaveBeenCalledTimes(2);
});
it.each(['Package: wrong\nVersion: 1.0.22\nArchitecture: amd64', 'Package: data-fusion-desktop\nVersion: 1.0.21\nArchitecture: amd64',
  'Package: data-fusion-desktop\nVersion: 1.0.22\nArchitecture: arm64'])('rejects mismatched package metadata before launch', async metadata => {
  const f = await fixture(); f.dependencies.inspect.mockResolvedValue(metadata);
  await expect(prepareLinuxUpdate(f.options, f.dependencies)).rejects.toThrow('不匹配'); expect(f.dependencies.open).not.toHaveBeenCalled();
});
it('refuses files changed after preparation, without opening a desktop handler', async () => {
  const f = await fixture(); const prepared = await prepareLinuxUpdate(f.options, f.dependencies); await writeFile(f.file, 'tampered');
  await expect(prepared.open()).rejects.toThrow('改变'); expect(f.dependencies.open).not.toHaveBeenCalled();
});
it('rejects the wrong OS, target architecture and paths outside the private cache', async () => {
  const f = await fixture();
  await expect(prepareLinuxUpdate({ ...f.options, platform: 'win32' }, f.dependencies)).rejects.toThrow('不匹配');
  await expect(prepareLinuxUpdate({ ...f.options, target: { platform: 'linux', arch: 'arm64' } }, f.dependencies)).rejects.toThrow('不匹配');
  await expect(prepareLinuxUpdate({ ...f.options, updatesDirectory: join(f.options.updatesDirectory, 'other') }, f.dependencies)).rejects.toThrow('下载目录');
  expect(f.dependencies.open).not.toHaveBeenCalled();
});
it('rejects an opener that spawns successfully but exits nonzero, and accepts a successful handoff', async () => {
  await expect(waitForDesktopInstaller(spawn(process.execPath, ['-e', 'process.exit(7)'], { windowsHide: true, stdio: 'ignore' }))).rejects.toThrow('启动失败');
  await expect(waitForDesktopInstaller(spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' }))).resolves.toBeUndefined();
});
