import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../main/browser-auth', () => ({ observeBrowserAuth: vi.fn(), clearBrowserAuth: vi.fn(async () => {}) }));
import { observeBrowserAuth } from '../../main/browser-auth';
import { transportPractitionerPlugin } from './index';
import { PRACTITIONER_GATEWAY_URL } from './client';

describe('practitioner login and authenticated home routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the confirmed login entry separately from the authenticated home', () => {
    expect(transportPractitionerPlugin.loginPage?.url).toBe('https://td.gd.gov.cn/cyry/default/index');
    expect(transportPractitionerPlugin.sessionRecovery?.homeUrl()).toBe('https://td.gd.gov.cn/cyry/index.html');
    expect(transportPractitionerPlugin.loginPage?.allowedOrigin).toBe('https://td.gd.gov.cn');
  });

  it('keeps gateway calls and login observation rooted at /cyry/api, not under the login page', async () => {
    await transportPractitionerPlugin.initialize();
    expect(PRACTITIONER_GATEWAY_URL).toBe('https://td.gd.gov.cn/cyry/api/ServiceGateway/DataService');
    expect(observeBrowserAuth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      partition: 'persist:transport-practitioner', urlPattern: 'https://td.gd.gov.cn/cyry/api/*/DataService*', header: 'token',
    }));
  });
});
