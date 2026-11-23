import { beforeEach, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../core/ipc/channels';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(), status: vi.fn(), writeText: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<unknown>) => fixture.handlers.set(name, handler) },
  clipboard: { writeText: fixture.writeText },
}));
vi.mock('./runtime', () => ({ appRuntime: { license: { getStatus: fixture.status } } }));
vi.mock('./login-tab', () => ({ loginTabController: {} }));
import { registerIpcHandlers } from './ipc';

const frame = {};
const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
const copy = (kind: unknown, sender = event) => fixture.handlers.get(IPC_CHANNELS.licenseCopyIdentifier)!(sender, kind);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.handlers.clear();
  registerIpcHandlers(() => 7);
});

it('copies the complete identifier from the local status and keeps inactive authorization locatable', async () => {
  fixture.status.mockResolvedValue({
    state: 'expired', deviceId: 'a'.repeat(64), identity: { licenseId: 'full-authorization-number' },
  });
  await copy('license');
  await copy('device');
  expect(fixture.writeText.mock.calls).toEqual([['full-authorization-number'], ['a'.repeat(64)]]);
});

it('rejects untrusted frames, arbitrary clipboard text and missing authorization numbers', async () => {
  await expect(copy('device', { ...event, senderFrame: {} })).rejects.toThrow('非受信');
  await expect(copy('clipboard fixture text')).rejects.toThrow('授权标识类型无效');
  expect(fixture.status).not.toHaveBeenCalled();
  fixture.status.mockResolvedValue({ state: 'missing', deviceId: 'a'.repeat(64) });
  await expect(copy('license')).rejects.toThrow('没有可复制的授权编号');
  expect(fixture.writeText).not.toHaveBeenCalled();
});
