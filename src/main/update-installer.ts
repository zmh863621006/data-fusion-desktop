import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';

/** electron-builder's UUID v5 of cn.zzkj.datafusion.desktop. Keep the application id stable. */
export const NSIS_INSTALL_REGISTRY_KEY = 'Software\\7030467a-ac8a-531f-b76e-ee2a205ae613';
export interface PrepareUpdateInstallOptions {
  installerPath: string;
  expectedSha256: string;
  installDirectory: string;
  executablePath: string;
  userDataDirectory: string;
  defaultUserDataDirectory: string;
  version: string;
  isPackaged: boolean;
  parentPid?: number;
  platform?: NodeJS.Platform;
  readyTimeoutMs?: number;
  exitTimeoutMs?: number;
}
export interface PreparedUpdateInstall {
  resultPath: string;
  /** Call only after business/session storage has been flushed successfully, then quit normally. */
  commit(): Promise<void>;
  /** Also works after commit while the original parent process remains alive. Never kills a process. */
  cancel(): Promise<void>;
}
export interface UpdateInstallResult {
  version: string;
  status: 'prepared' | 'waiting' | 'installing' | 'installed' | 'failed' | 'cancelled';
  code?: string;
  at: number;
  handoffId: string;
}

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const hashPattern = /^[a-f0-9]{64}$/;
const pathKey = (path: string) => win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();
function fullPath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && win32.isAbsolute(value)
    && !/[\x00-\x1f"<>|?*]/.test(value) && !value.slice(2).includes(':') && value.length < 1000;
}
const inside = (path: string, directory: string) => {
  const relative = win32.relative(directory, path);
  return Boolean(relative) && !relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative);
};
const statusValues = new Set(['prepared', 'waiting', 'installing', 'installed', 'failed', 'cancelled']);

/** Read only the small machine-readable outcome; no paths, secrets or upstream messages are returned. */
export async function readUpdateInstallResult(userDataDirectory: string): Promise<UpdateInstallResult | null> {
  try {
    const text = await readFile(win32.join(userDataDirectory, 'updates', 'update-install-result.json'), 'utf8');
    if (text.length > 4096) return null;
    const value = JSON.parse(text) as UpdateInstallResult;
    if (!VERSION.test(value.version) || !statusValues.has(value.status) || !Number.isSafeInteger(value.at)
      || typeof value.handoffId !== 'string' || !/^handoff-[a-z0-9]+$/i.test(value.handoffId)
      || (value.code !== undefined && (typeof value.code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value.code)))) return null;
    return { version: value.version, status: value.status, at: value.at, handoffId: value.handoffId,
      ...(value.code ? { code: value.code } : {}) };
  } catch { return null; }
}

export function updateInstallFailureMessage(code?: string): string {
  const messages: Record<string, string> = {
    export_backup_failed: '更新前的导出文件备份未完成，已停止安装。请保存并关闭正在编辑的导出表格，再查看安装备份日志',
    export_restore_failed: '新版本安装后的导出恢复未完成。请保留用户目录中的导出备份并联系管理员',
    another_application_running: '检测到另一个数据融合助手窗口，已停止安装。请关闭其他窗口后重试',
    parent_exit_timeout: '应用未能在等待时间内正常退出，已停止安装。请保存工作并正常关闭后重试',
    installer_hash_mismatch: '更新包校验不一致，未执行安装。请重新检查并下载更新',
    installer_missing: '下载的更新包已不存在。请查看安全软件拦截记录，再重新检查更新',
    installed_version_mismatch: '安装后的版本未通过核对。请查看安装日志或使用官方完整安装包升级',
    graphics_runtime_unavailable: '安装包内的图形组件加载失败，升级已停止。请查看安装诊断日志或重新下载完整安装包',
    legacy_graphics_file_in_use: '旧图形组件仍被占用，安装未完成。请关闭占用安装目录的程序后重试，导出文件及备份已保留',
    installer_check_failed: '安装检查程序未能正常运行，安装已停止。请查看安装诊断日志中的检查退出码和错误详情',
  };
  return messages[code ?? ''] ?? '上次更新未完成。请查看系统或安全软件拦截记录，或使用官方完整安装包手动升级';
}


function preparationError(code?: string): Error {
  const messages: Record<string, string> = {
    unregistered_installation: '当前是免安装版或未登记的安装版本，请先使用正式安装包覆盖安装一次，再使用自动更新',
    development_directory: '开发项目目录不能被自动更新覆盖，请使用正式安装版',
    parent_identity_invalid: '当前应用进程无法安全核对，已取消自动安装',
    installation_path_invalid: '当前安装目录无法安全核对，已取消自动安装',
    installation_already_prepared: '已有一个更新安装交接正在等待，请稍后重试',
  };
  return new Error(messages[code ?? ''] ?? '更新助手未能启动或就绪，已取消安装并保留当前应用。请查看系统或安全软件的拦截记录，或使用官方完整安装包手动升级');
}

interface InstallerDependencies {
  spawn: typeof spawnProcess;
  delay: (ms: number) => Promise<void>;
  now: () => number;
}

export class UpdateInstaller {
  private active = false;
  private readonly dependencies: InstallerDependencies;
  constructor(dependencies: Partial<InstallerDependencies> = {}) {
    this.dependencies = { spawn: spawnProcess, delay: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now, ...dependencies };
  }

  async prepare(options: PrepareUpdateInstallOptions): Promise<PreparedUpdateInstall> {
    if (this.active) throw new Error('已有更新安装交接正在准备，请勿重复操作');
    if ((options.platform ?? process.platform) !== 'win32' || !options.isPackaged) throw new Error('开发版不支持自动覆盖更新，请使用正式 Windows 安装包');
    const parentPid = options.parentPid ?? process.pid;
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid > 0x7fffffff || !VERSION.test(options.version) || !hashPattern.test(options.expectedSha256)) throw new Error('更新安装参数无效');
    const paths = [options.installerPath, options.installDirectory, options.executablePath, options.userDataDirectory, options.defaultUserDataDirectory];
    if (!paths.every(fullPath)) throw new Error('更新安装路径无效');
    if (pathKey(options.userDataDirectory) !== pathKey(options.defaultUserDataDirectory)) throw new Error('自定义用户数据目录不支持自动安装，请使用安装包手动升级以保留当前数据位置');
    const installDirectory = win32.normalize(options.installDirectory), executablePath = win32.normalize(options.executablePath);
    const userDataDirectory = win32.normalize(options.userDataDirectory), updatesDirectory = win32.join(userDataDirectory, 'updates');
    const installerPath = win32.normalize(options.installerPath);
    const broadPaths = [win32.parse(installDirectory).root, process.env.SystemRoot, process.env.USERPROFILE, process.env.APPDATA,
      process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData,
      win32.join(win32.parse(installDirectory).root, 'Users'),
      ...(process.env.USERPROFILE ? ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'].map(name => win32.join(process.env.USERPROFILE!, name)) : []),
      ...(process.env.LOCALAPPDATA ? [win32.join(process.env.LOCALAPPDATA, 'Programs')] : []),
      ...(process.env.SystemRoot ? [win32.join(process.env.SystemRoot, 'System32')] : [])].filter((value): value is string => Boolean(value));
    if (broadPaths.some(path => pathKey(path) === pathKey(installDirectory)) || pathKey(installDirectory) === pathKey(userDataDirectory)
      || inside(userDataDirectory, installDirectory) || inside(installDirectory, userDataDirectory)
      || pathKey(win32.dirname(executablePath)) !== pathKey(installDirectory) || win32.basename(executablePath) !== 'DataFusion.exe'
      || !inside(installerPath, updatesDirectory) || win32.extname(installerPath).toLowerCase() !== '.exe') throw new Error('更新包或目标目录不在安全范围内，已取消自动安装');
    const readyTimeoutMs = options.readyTimeoutMs ?? 15_000, exitTimeoutMs = options.exitTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 60_000
      || !Number.isSafeInteger(exitTimeoutMs) || exitTimeoutMs < 1 || exitTimeoutMs > 600_000) throw new Error('更新安装超时参数无效');
    this.active = true;
    let handoffDirectory: string | undefined;
    let token = '';
    const marker = async (name: string): Promise<void> => {
      if (!handoffDirectory) return;
      const temporary = win32.join(handoffDirectory, `${name}.writing`), finalPath = win32.join(handoffDirectory, name);
      await writeFile(temporary, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, finalPath);
    };
    try {
      await mkdir(updatesDirectory, { recursive: true, mode: 0o700 });
      handoffDirectory = await mkdtemp(win32.join(updatesDirectory, 'handoff-'));
      token = randomBytes(32).toString('hex');
      const configurationPath = win32.join(handoffDirectory, 'configuration.json');
      const handoffId = win32.basename(handoffDirectory);
      await writeFile(configurationPath, JSON.stringify({ schema: 1, token, handoffId, handoffDirectory, updatesDirectory,
        installerPath, expectedSha256: options.expectedSha256, installDirectory, executablePath, parentPid, exitTimeoutMs, version: options.version }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // Run a byte-for-byte copy outside the installation directory so Windows can
      // replace the installed helper while this independent GUI process remains alive.
      const hostPath = win32.join(handoffDirectory, 'DataFusion.UpdateHost.exe');
      await writeFile(hostPath, await readFile(win32.join(installDirectory, 'resources', 'update', 'DataFusion.UpdateHost.exe')), { flag: 'wx', mode: 0o700 });
      let failed = false;
      // The GUI host performs the entire handoff with native APIs. It accepts data
      // through its configuration file and never starts a command interpreter.
      const child: ChildProcess = this.dependencies.spawn(hostPath, [],
        { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, DATA_FUSION_UPDATE_CONFIG: configurationPath } });
      child.once('error', () => { failed = true; });
      child.once('exit', () => { failed = true; });
      child.unref();
      const deadline = this.dependencies.now() + readyTimeoutMs;
      let ready = false;
      while (this.dependencies.now() < deadline) {
        try {
          const value = JSON.parse(await readFile(win32.join(handoffDirectory, 'ready.json'), 'utf8')) as { token?: string; ready?: boolean };
          ready = value.token === token && value.ready === true;
        } catch { /* Only the expected helper's random-token ready marker is accepted. */ }
        if (ready && !failed) break;
        try {
          const value = JSON.parse(await readFile(win32.join(handoffDirectory, 'result.json'), 'utf8')) as UpdateInstallResult;
          if (value.handoffId === handoffId && value.status === 'failed') throw preparationError(value.code);
        } catch (error) { if (error instanceof Error && !('code' in error) && !(error instanceof SyntaxError)) throw error; }
        if (failed) throw preparationError();
        await this.dependencies.delay(50);
      }
      if (!ready || failed) throw preparationError();
      const preparedAt = this.dependencies.now();
      let state: 'prepared' | 'committed' | 'cancelled' = 'prepared';
      let cancelRequested = false;
      let committing: Promise<void> | undefined, cancelling: Promise<void> | undefined;
      return {
        resultPath: win32.join(updatesDirectory, 'update-install-result.json'),
        commit: async () => {
          if (cancelRequested || state === 'cancelled') throw new Error('更新安装已取消');
          if (state === 'committed') return;
          if (failed || this.dependencies.now() - preparedAt >= exitTimeoutMs) throw preparationError();
          try {
            const value = JSON.parse(await readFile(win32.join(handoffDirectory!, 'result.json'), 'utf8')) as UpdateInstallResult;
            if (value.handoffId === handoffId && ['failed', 'cancelled'].includes(value.status)) throw preparationError(value.code);
          } catch (error) { if (error instanceof Error && !('code' in error) && !(error instanceof SyntaxError)) throw error; }
          if (cancelRequested) throw new Error('更新安装已取消');
          committing ??= marker('commit.json').then(() => { if (state !== 'cancelled') state = 'committed'; });
          await committing;
          if (cancelRequested) { await cancelling; throw new Error('更新安装已取消'); }
        },
        cancel: async () => {
          // Cancellation takes precedence even when a commit marker already exists.
          // All callers await the same durable marker. Never acknowledge a concurrent
          // cancellation before its write, or silently turn a failed write into success.
          cancelRequested = true;
          cancelling ??= marker('cancel.json').then(() => { state = 'cancelled'; this.active = false; });
          await cancelling;
        },
      };
    } catch (error) {
      await marker('cancel.json').catch(() => {});
      this.active = false;
      throw error;
    }
  }
}

const installer = new UpdateInstaller();
export const prepareUpdateInstall = (options: PrepareUpdateInstallOptions): Promise<PreparedUpdateInstall> => installer.prepare(options);
