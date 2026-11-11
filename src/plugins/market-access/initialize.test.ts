import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: vi.fn(() => ({})) } }));
import { MarketAccessClient } from './client';
import { marketAccessPlugin } from './index';

it('initializes a fresh tools-only installation without contacting the intranet', async () => {
  const query = vi.spyOn(MarketAccessClient.prototype, 'currentUser').mockRejectedValue(new Error('Intranet must not be called before the window opens'));
  await marketAccessPlugin.initialize();
  expect(query).not.toHaveBeenCalled();
  query.mockRestore();
});
