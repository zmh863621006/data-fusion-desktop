import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, realpath, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { artifactMatchesTarget, type UpdateArtifact, type UpdateTarget } from '../core/updater/service';

const execute = promisify(execFile);
export function waitForDesktopInstaller(child: ChildProcess, settleMs = 1500): Promise<void> {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { child.unref(); done(); }, settleMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法打开系统安装器，请使用已下载的麒麟安装包手动安装')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) done(); else reject(new Error('系统安装器启动失败，请检查桌面软件安装程序后重试'));
    });
  });
}
interface LinuxInstallerDependencies {
  inspect(file: string): Promise<string>;
  open(file: string): Promise<void>;
}
const native: LinuxInstallerDependencies = {
  inspect: async file => (await execute('/usr/bin/dpkg-deb', ['--field', file, 'Package', 'Version', 'Architecture'],
    { timeout: 15_000, maxBuffer: 16_384, encoding: 'utf8' })).stdout,
  open: async file => {
    // Prefer the distro's actual software store. Some Kylin desktops retain an
    // obsolete GNOME .desktop MIME association even when GNOME Software is absent.
    const executable = async (path: string) => access(path, constants.X_OK).then(() => true, () => false);
    const command = await executable('/usr/bin/kylin-software-center') ? '/usr/bin/kylin-software-center'
      : await executable('/usr/bin/gnome-software') ? '/usr/bin/gnome-software' : '/usr/bin/xdg-open';
    const args = command.endsWith('/gnome-software') ? ['--local-filename', file] : [file];
    // Detect immediate launcher failures. A still-running store owns its normal
    // confirmation UI; never terminate it or run the package manager as root.
    await waitForDesktopInstaller(spawn(command, args, { detached: true, stdio: 'ignore' }));
  },
};

export async function prepareLinuxUpdate(options: {
  installerPath: string; updatesDirectory: string; artifact: UpdateArtifact; target: UpdateTarget; platform?: string;
}, dependencies: LinuxInstallerDependencies = native): Promise<{ open(): Promise<void> }> {
  const { artifact, target } = options;
  if ((options.platform ?? process.platform) !== 'linux' || target.platform !== 'linux' || !artifactMatchesTarget(artifact, target))
    throw new Error('麒麟更新包与当前系统或芯片架构不匹配');
  const path = resolve(options.installerPath), root = resolve(options.updatesDirectory);
  if (dirname(path) !== root || !path.endsWith('.deb')) throw new Error('麒麟更新包不在应用下载目录内');
  const validate = async () => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size !== artifact.bytes || await realpath(path) !== path)
      throw new Error('麒麟更新包文件或大小已改变，请重新下载');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== artifact.sha256) throw new Error('麒麟更新包摘要校验失败');
    let output: string;
    try { output = await dependencies.inspect(path); }
    catch { throw new Error('无法读取麒麟安装包信息，请重新下载完整安装包'); }
    const metadata = new Map(output.split(/\r?\n/).map(line => {
      const split = line.indexOf(':'); return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
    }));
    if (metadata.get('Package') !== 'data-fusion-desktop' || metadata.get('Version') !== artifact.version
      || metadata.get('Architecture') !== (target.arch === 'x64' ? 'amd64' : 'arm64'))
      throw new Error('麒麟安装包的程序、版本或芯片架构不匹配');
  };
  await validate();
  return { open: async () => { await validate(); await dependencies.open(path); } };
}
