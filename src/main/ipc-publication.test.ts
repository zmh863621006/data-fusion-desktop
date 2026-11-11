import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLICATION_PLATFORMS } from '../core/publication/platforms';

const f = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  requireLicense: vi.fn(), fromWebContents: vi.fn(), open: vi.fn(), activate: vi.fn(), state: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: f.fromWebContents },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => f.handlers.set(channel, handler) } }));
vi.mock('./runtime', () => ({ appRuntime: { requireLicense: f.requireLicense } }));
vi.mock('./login-tab', () => ({ loginTabController: { open: f.open, activate: f.activate, state: f.state } }));
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';

const frame = {}, event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame }, window = {};
const open = (id: unknown, sender = event) => f.handlers.get(IPC_CHANNELS.publicationOpen)!(sender, id);

describe('publication login entry IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.handlers.clear(); f.requireLicense.mockResolvedValue({ allowedSystems: ['government-info'] });
    f.fromWebContents.mockReturnValue(window); f.state.mockReturnValue({ tabs: [], activeSystemId: null });
    registerIpcHandlers(() => 7);
  });

  it.each(Object.values(PUBLICATION_PLATFORMS))('opens only the fixed $id login destination without batch data or business auth hooks', async platform => {
    await open(platform.id);
    expect(f.requireLicense).toHaveBeenCalledExactlyOnceWith('government-info');
    expect(f.open).toHaveBeenCalledExactlyOnceWith(window, {
      id: platform.id, name: platform.name,
      loginPage: { url: platform.url, allowedOrigin: platform.allowedOrigin, partition: platform.partition },
    }, null, { persistStorage: false });
    expect(f.open.mock.calls[0][1]).not.toHaveProperty('getSessionState');
    expect(new URL(platform.url).origin).toBe(platform.allowedOrigin);
    expect(f.state).toHaveBeenCalledOnce();
  });

  it.each(['https://attacker.test/', 'javascript:alert(1)', '__proto__', 'constructor', 'government-info', '', null, {}])('rejects arbitrary caller destinations: %j', async id => {
    await expect(open(id)).rejects.toThrow('公示平台无效');
    expect(f.open).not.toHaveBeenCalled(); expect(f.requireLicense).not.toHaveBeenCalled();
  });

  it('rejects untrusted frames before looking up or opening a destination', async () => {
    await expect(open('nanshan-publicity', { ...event, senderFrame: {} })).rejects.toThrow('非受信');
    expect(f.requireLicense).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });

  it('requires government authorization before creating a browser view', async () => {
    f.requireLicense.mockRejectedValue(new Error('LICENSE_SYSTEM_DENIED'));
    await expect(open('nanshan-publicity')).rejects.toThrow('LICENSE_SYSTEM_DENIED');
    expect(f.fromWebContents).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });

  it('checks the owning system grant when switching back to a preserved publication tab', async () => {
    await f.handlers.get(IPC_CHANNELS.systemTabActivate)!(event, 'guangdong-law-publicity');
    expect(f.requireLicense).toHaveBeenCalledExactlyOnceWith('government-info');
    expect(f.activate).toHaveBeenCalledExactlyOnceWith('guangdong-law-publicity');
    f.requireLicense.mockRejectedValue(new Error('LICENSE_SYSTEM_DENIED'));
    await expect(f.handlers.get(IPC_CHANNELS.systemTabActivate)!(event, 'nanshan-publicity')).rejects.toThrow('LICENSE_SYSTEM_DENIED');
    expect(f.activate).toHaveBeenCalledOnce();
  });
});
