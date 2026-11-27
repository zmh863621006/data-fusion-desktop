import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));
import { session } from 'electron';
import { prepareHrssBrowserSession } from './hrss-browser-session';

it('uses direct source routing and a compatible product name without changing the Linux browser version', async () => {
  const browser = {
    getUserAgent: () => 'Mozilla/5.0 (X11; Linux aarch64) 数据融合助手/1.1.14 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36',
    setUserAgent: vi.fn(), setProxy: vi.fn(async () => {}),
  };
  vi.mocked(session.fromPartition).mockReturnValue(browser as unknown as ReturnType<typeof session.fromPartition>);
  await prepareHrssBrowserSession();
  expect(session.fromPartition).toHaveBeenCalledExactlyOnceWith('persist:guangdong-hrss');
  expect(browser.setUserAgent).toHaveBeenCalledExactlyOnceWith('Mozilla/5.0 (X11; Linux aarch64) DataFusion/1.1.14 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36');
  expect(browser.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'direct' });
});
