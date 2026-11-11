import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess, type spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateInstaller, readUpdateInstallResult, updateInstallFailureMessage, type PrepareUpdateInstallOptions } from './update-installer';

const directories: string[] = [];
const children: EventEmitter[] = [];
afterEach(async () => {
  children.splice(0).forEach(child => child.removeAllListeners());
  for (const directory of directories.splice(0)) {
    // Only these independently-created fixture folders can ever be removed.
    if (dirname(resolve(directory)) === resolve(tmpdir()) && win32.basename(directory).startsWith('fusion-update-installer-')) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
type HelperMode = 'ready' | 'wrong-token' | 'failure' | 'spawn-error' | 'exit' | 'none';
async function fixture(mode: HelperMode = 'ready') {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-update-installer-')); directories.push(directory);
  const userDataDirectory = join(directory, 'profile');
  const installDirectory = join(directory, "安装目录 O'Brien & safe; $HOME");
  await mkdir(join(installDirectory, 'resources/update'), { recursive: true });
  await writeFile(join(installDirectory, 'resources/update/DataFusion.UpdateHost.exe'), 'native-host-fixture');
  const options: PrepareUpdateInstallOptions = {
    installerPath: join(userDataDirectory, 'updates', 'DataFusion-Setup-1.0.3-x64.exe'),
    expectedSha256: 'a'.repeat(64), installDirectory, executablePath: join(installDirectory, 'DataFusion.exe'),
    userDataDirectory, defaultUserDataDirectory: userDataDirectory, parentPid: 1234, version: '1.0.3',
    isPackaged: true, platform: 'win32', readyTimeoutMs: 2000, exitTimeoutMs: 1000,
  };
  let clock = 0;
  let configurationPath = '';
  let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
  const spawnHelper = vi.fn((file, args, settings) => {
    configurationPath = settings.env.DATA_FUSION_UPDATE_CONFIG;
    child = Object.assign(new EventEmitter(), { unref: vi.fn() }); children.push(child);
    void (async () => {
      const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
      if (mode === 'ready' || mode === 'wrong-token') {
        await writeFile(join(configuration.handoffDirectory, 'ready.json'), JSON.stringify({ token: mode === 'ready' ? configuration.token : 'wrong', ready: true }));
      } else if (mode === 'failure') {
        await writeFile(join(configuration.handoffDirectory, 'result.json'), JSON.stringify({ handoffId: configuration.handoffId, status: 'failed', code: 'unregistered_installation' }));
      } else if (mode === 'spawn-error') child.emit('error', new Error('private process failure details'));
      else if (mode === 'exit') child.emit('exit', 1);
    })();
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const installer = new UpdateInstaller({ spawn: spawnHelper, now: () => clock, delay: async ms => {
    clock += ms; await new Promise(resolve => setTimeout(resolve, 2));
  } });
  return { directory, options, installer, spawnHelper: vi.mocked(spawnHelper), configurationPath: () => configurationPath,
    advanceClock: (milliseconds: number) => { clock += milliseconds; } };
}

describe('safe Windows NSIS update handoff', () => {
  it('prepares a hidden fixed helper without interpolating Unicode paths into a command or changing execution policy', async () => {
    const f = await fixture();
    const prepared = await f.installer.prepare(f.options);
    const [executable, args, settings] = f.spawnHelper.mock.calls[0];
    expect(executable).toBe(win32.join(win32.dirname(f.configurationPath()), 'DataFusion.UpdateHost.exe'));
    expect(await readFile(executable as string, 'utf8')).toBe('native-host-fixture');
    expect(settings).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' });
    expect(settings?.shell).toBeUndefined();
    expect(args).not.toContain('-ExecutionPolicy');
    expect(args).not.toContain('Bypass');
    expect(args).toEqual([]); // The GUI host accepts no downloaded command or script path.
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    expect(configuration).toMatchObject({ parentPid: 1234, installDirectory: f.options.installDirectory, executablePath: f.options.executablePath, expectedSha256: f.options.expectedSha256 });
    expect(configuration.token).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.resultPath).toBe(join(f.options.userDataDirectory, 'updates', 'update-install-result.json'));
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
    await prepared.cancel();
  });
  it('writes a commit only on explicit successful-save authorization, then permits cancellation before exit', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    await Promise.all([prepared.commit(), prepared.commit()]);
    expect(JSON.parse(await readFile(join(configuration.handoffDirectory, 'commit.json'), 'utf8'))).toEqual({ token: configuration.token });
    await prepared.cancel();
    expect(JSON.parse(await readFile(join(configuration.handoffDirectory, 'cancel.json'), 'utf8'))).toEqual({ token: configuration.token });
    await expect(prepared.commit()).rejects.toThrow('已取消');
  });
  it('a failed business/session save cancels without ever making a commit marker', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    // The main process owns saving; its failure path must use cancel(), not commit().
    await prepared.cancel(); await prepared.cancel();
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
    expect(await readdir(configuration.handoffDirectory)).toContain('cancel.json');
    expect(f.spawnHelper).toHaveBeenCalledTimes(1);
  });
  it('concurrent cancellation calls all wait for the durable cancellation marker', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    const first = prepared.cancel(), second = prepared.cancel();
    await second;
    expect(JSON.parse(await readFile(join(configuration.handoffDirectory, 'cancel.json'), 'utf8'))).toEqual({ token: configuration.token });
    await first;
  });
  it('does not acknowledge a failed cancellation as success on a repeated call', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    await writeFile(join(configuration.handoffDirectory, 'cancel.json.writing'), 'occupied');
    await expect(prepared.cancel()).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(prepared.cancel()).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(prepared.commit()).rejects.toThrow('已取消');
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
  });
  it('cancellation requested during a commit check prevents the commit from being written', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    const committing = prepared.commit(); const cancelling = prepared.cancel();
    await expect(committing).rejects.toThrow('已取消'); await cancelling;
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
    expect(await readdir(configuration.handoffDirectory)).toContain('cancel.json');
  });
  it('a failed atomic commit remains cancellable and never silently treats a partial marker as success', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    await writeFile(join(configuration.handoffDirectory, 'commit.json.writing'), 'occupied');
    await expect(prepared.commit()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
    await prepared.cancel();
    expect(await readdir(configuration.handoffDirectory)).toContain('cancel.json');
  });
  it('does not commit after the helper exit deadline, and leaves the parent free to cancel safely', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    f.advanceClock(2000);
    await expect(prepared.commit()).rejects.toThrow('已取消安装');
    await prepared.cancel();
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
  });
  it('honors a terminal helper failure even if a previous ready marker remains on disk', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    await writeFile(join(configuration.handoffDirectory, 'result.json'), JSON.stringify({ handoffId: configuration.handoffId, status: 'failed', code: 'parent_exit_timeout' }));
    await expect(prepared.commit()).rejects.toThrow('已取消安装');
    await prepared.cancel();
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
  });
  it.each<HelperMode>(['wrong-token', 'none', 'spawn-error', 'exit'])('readiness failure (%s) cancels safely without killing any process or leaking errors', async mode => {
    const f = await fixture(mode);
    await expect(f.installer.prepare(f.options)).rejects.toThrow('已取消安装');
    const configuration = JSON.parse(await readFile(f.configurationPath(), 'utf8'));
    expect(await readdir(configuration.handoffDirectory)).toContain('cancel.json');
    expect(await readdir(configuration.handoffDirectory)).not.toContain('commit.json');
  });
  it('fails closed for ZIP/unregistered installs before allowing the parent to exit', async () => {
    const f = await fixture('failure');
    await expect(f.installer.prepare(f.options)).rejects.toThrow('正式安装包覆盖安装一次');
  });
  it('rejects overlapping preparations, but permits a fresh attempt after cancelling', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    await expect(f.installer.prepare(f.options)).rejects.toThrow('已有更新安装交接');
    await prepared.cancel();
    const again = await f.installer.prepare(f.options); await again.cancel();
    expect(f.spawnHelper).toHaveBeenCalledTimes(2);
  });
  it.each([
    { isPackaged: false }, { platform: 'linux' }, { parentPid: -1 }, { version: '1.0.3 && execute' },
    { expectedSha256: 'not-a-sha256' }, { installDirectory: 'C:\\', executablePath: 'C:\\DataFusion.exe' },
    { installerPath: 'C:\\Windows\\malicious.exe' }, { executablePath: 'C:\\elsewhere\\electron.exe' },
    { userDataDirectory: 'C:\\custom-profile' }, { installerPath: 'C:\\profile\\updates\\evil.exe:alternate' },
    { readyTimeoutMs: 0 }, { exitTimeoutMs: 600001 },
  ] satisfies Partial<PrepareUpdateInstallOptions>[])('refuses unsafe mode/paths/parameters without spawning: %j', async patch => {
    const f = await fixture();
    await expect(f.installer.prepare({ ...f.options, ...patch })).rejects.toThrow();
    expect(f.spawnHelper).not.toHaveBeenCalled();
  });
  it('machine-readable results return only allowlisted fields and reject malformed values', async () => {
    const f = await fixture(); const prepared = await f.installer.prepare(f.options);
    await writeFile(prepared.resultPath, JSON.stringify({ version: '1.0.3', status: 'failed', code: 'installer_hash_mismatch', at: 100,
      handoffId: 'handoff-abc123', privatePath: 'do not expose', exception: 'do not expose' }));
    expect(await readUpdateInstallResult(f.options.userDataDirectory)).toEqual({ version: '1.0.3', status: 'failed', code: 'installer_hash_mismatch', at: 100, handoffId: 'handoff-abc123' });
    await writeFile(prepared.resultPath, JSON.stringify({ version: '1.0.3', status: 'failed', code: 'raw private error text', at: 100, handoffId: 'handoff-abc123' }));
    expect(await readUpdateInstallResult(f.options.userDataDirectory)).toBeNull();
    await prepared.cancel();
  });
  it.skipIf(process.platform !== 'win32')('the native host preserves the complete Windows update protocol without a script interpreter', () => {
    const output = execFileSync(process.execPath, ['scripts/verify-native-update-host.mjs'], {
      windowsHide: true, timeout: 90000, encoding: 'utf8',
    });
    expect(JSON.parse(output.trim())).toMatchObject({ status: 'passed', nativeUpdateHost: true, scriptInterpreterRequired: false });
  }, 95000);
  it('explains backup, file-integrity and process failures without recommending disabled protection', () => {
    expect(updateInstallFailureMessage('export_backup_failed')).toContain('备份未完成');
    expect(updateInstallFailureMessage('export_restore_failed')).toContain('恢复未完成');
    expect(updateInstallFailureMessage('another_application_running')).toContain('另一个');
    expect(updateInstallFailureMessage('installer_hash_mismatch')).toContain('未执行安装');
    expect(updateInstallFailureMessage('installer_missing')).toContain('拦截记录');
    expect(updateInstallFailureMessage('graphics_runtime_unavailable')).toContain('安装包内的图形组件');
    expect(updateInstallFailureMessage('legacy_graphics_file_in_use')).toContain('旧图形组件');
    expect(updateInstallFailureMessage('installer_check_failed')).toContain('检查程序未能正常运行');
    expect(updateInstallFailureMessage('installer_check_failed')).not.toContain('Windows图形组件不可用');
    expect(updateInstallFailureMessage('untrusted error text')).not.toContain('untrusted error text');
  });
});
