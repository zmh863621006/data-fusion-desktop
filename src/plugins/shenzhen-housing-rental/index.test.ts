import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ session: {} }));
import { HOUSING_HOME_URL, HOUSING_LOGIN_URL, HOUSING_ORIGIN, HOUSING_PARTITION } from './catalog';
import { createHousingRentalPlugin } from './index';

describe('housing rental credential configuration', () => {
  it('enables saved credentials only on the existing login path and preserves the authenticated home', () => {
    const fetcher = vi.fn();
    const plugin = createHousingRentalPlugin({ fetcher, observeBrowser: false });
    expect(plugin.supportsCredentialConfiguration).toBe(true);
    expect(plugin.loginMode).toBe('embedded');
    expect(plugin.loginPage).toMatchObject({
      url: HOUSING_LOGIN_URL, partition: HOUSING_PARTITION, allowedOrigin: HOUSING_ORIGIN,
      credentialPaths: ['/fwzl/LEAP/Login/4403/ZIBNEW/Login.html'],
    });
    expect(plugin.loginPage!.credentialPaths).not.toContain(new URL(HOUSING_HOME_URL).pathname);
    expect(plugin.sessionRecovery!.homeUrl()).toBe(HOUSING_HOME_URL);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    '<input id="fixture-account" autocomplete="username">',
    '<input id="fixture-account" name="username">',
    '<input id="fixture-account" name="account">',
    '<input id="fixture-account" placeholder="请输入用户名">',
    '<input id="fixture-account" placeholder="请输入账号">',
  ])('matches semantic account fields without choosing a preceding verification input: %s', account => {
    const fields = createHousingRentalPlugin({ observeBrowser: false }).loginPage!.credentialFields!;
    const $ = load(`<form><input id="verification" placeholder="验证码">${account}
      <input id="fixture-password" type="password"><button type="submit">登录</button></form>`);
    expect($(fields.account).map((_, el) => $(el).attr('id')).get()).toEqual(['fixture-account']);
    expect($(fields.password).map((_, el) => $(el).attr('id')).get()).toEqual(['fixture-password']);
  });
});
