import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));

import { AppRuntime } from './runtime';
import { marketAccessPlugin } from '../plugins/market-access';
import { governmentInfoPlugin } from '../plugins/government-info';
import * as onlineCar from '../plugins/online-car-permit';
import type { SystemCredentials } from './credential-store';

describe('credential configuration for browser-login systems', () => {
  const stored = new Map<string, SystemCredentials>();
  const get = vi.fn(async (id: string) => stored.get(id) ?? null);
  const set = vi.fn(async (id: string, credentials: SystemCredentials) => { stored.set(id, credentials); });
  let runtime: AppRuntime;
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks(); stored.clear();
    runtime = new AppRuntime();
    runtime.plugins.register(marketAccessPlugin);
    runtime.plugins.register(governmentInfoPlugin);
    // In-memory store: never read or change the user's saved credentials.
    Object.assign(runtime, { credentialStore: { get, set } });
  });

  it.each([marketAccessPlugin, governmentInfoPlugin])('saves and loads $id without returning the password in renderer status', async plugin => {
    expect(plugin.supportsCredentialConfiguration).toBe(true);
    expect(await runtime.credentialStatus(plugin.id)).toEqual({ configured: false, account: '' });
    const result = await runtime.saveCredentials(plugin.id, 'fixture-account', 'fixture-password');
    expect(result).toEqual({ configured: true, account: 'fixture-account' });
    expect(await runtime.credentialStatus(plugin.id)).toEqual(result);
    expect(await runtime.credentialsForLogin(plugin.id)).toEqual({ account: 'fixture-account', password: 'fixture-password' });
    expect(set).toHaveBeenCalledWith(plugin.id, { account: 'fixture-account', password: 'fixture-password' });
  });

  it('keeps both systems separate and does not reconfigure another system', async () => {
    const otherSystem = vi.spyOn(onlineCar, 'configureOnlineCarPermitCredentials').mockImplementation(() => {});
    await runtime.saveCredentials('market-access', 'market-fixture', 'market-password');
    await runtime.saveCredentials('government-info', 'government-fixture', 'government-password');
    expect((await runtime.credentialsForLogin('market-access'))?.account).toBe('market-fixture');
    expect((await runtime.credentialsForLogin('government-info'))?.account).toBe('government-fixture');
    expect(otherSystem).not.toHaveBeenCalled();
  });

  it('rejects unsupported system IDs before accessing the credential store', async () => {
    await expect(runtime.saveCredentials('unknown-system', 'fixture', 'fixture')).rejects.toThrow('不支持');
    await expect(runtime.credentialStatus('unknown-system')).rejects.toThrow('不支持');
    await expect(runtime.credentialsForLogin('unknown-system')).rejects.toThrow('不支持');
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
});
