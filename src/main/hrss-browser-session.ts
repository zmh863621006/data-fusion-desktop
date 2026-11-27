import { session } from 'electron';
import { businessRequestUserAgent } from '../core/network/user-agent';
import { HRSS_PARTITION } from '../plugins/guangdong-hrss/catalog';

/** Keep source-page requests consistent with the API channel in this partition. */
export async function prepareHrssBrowserSession(): Promise<void> {
  const browser = session.fromPartition(HRSS_PARTITION);
  browser.setUserAgent(businessRequestUserAgent(browser.getUserAgent()));
  // The government portal must not inherit a local HTTP/SOCKS system proxy.
  await browser.setProxy({ mode: 'direct' });
}
