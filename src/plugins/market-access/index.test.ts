import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }));
import { marketAccessPlugin } from './index';

describe('market access authenticated home routing', () => {
  it('uses the confirmed frame page as the authenticated home without changing the login entry', () => {
    expect(marketAccessPlugin.sessionRecovery?.homeUrl()).toBe('http://19.88.234.125/app/page/frame.html');
    expect(marketAccessPlugin.loginPage?.url).toBe('http://19.88.234.125/');
  });

  it('keeps the home in the existing allowed origin and browser partition', () => {
    expect(new URL(marketAccessPlugin.sessionRecovery!.homeUrl()).origin).toBe(marketAccessPlugin.loginPage?.allowedOrigin);
    expect(marketAccessPlugin.loginPage?.partition).toBe('persist:market-access');
  });

  it('explicitly matches the legacy loginname/loginpwd fields, including a text-type password input', () => {
    expect(marketAccessPlugin.loginPage?.credentialFields).toEqual({ account: '#loginname', password: '#loginpwd' });
  });
});
