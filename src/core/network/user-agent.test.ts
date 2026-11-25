import { describe, expect, it } from 'vitest';
import { businessRequestUserAgent } from './user-agent';

describe('business request User-Agent compatibility', () => {
  it.each([
    ['Windows NT 10.0; Win64; x64', '152.0.7977.78', '44.3.0'],
    ['Windows NT 6.1; Win64; x64', '108.0.5359.215', '22.3.27'],
    ['X11; Linux aarch64', '152.0.7977.78', '44.3.0'],
  ])('keeps the real platform and engine for %s', (platform, chrome, electron) => {
    const agent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) 数据融合助手/1.1.11 Chrome/${chrome} Electron/${electron} Safari/537.36`;
    expect(businessRequestUserAgent(agent)).toBe(agent.replace('数据融合助手/', 'DataFusion/'));
    expect(businessRequestUserAgent(businessRequestUserAgent(agent))).toBe(businessRequestUserAgent(agent));
  });

  it('preserves existing ASCII product names and removes non-HTTP characters', () => {
    const agent = 'Mozilla/5.0 DataFusion/1.1.11 Chrome/152.0.7977.78 Electron/44.3.0';
    expect(businessRequestUserAgent(agent)).toBe(agent);
    expect(businessRequestUserAgent(`${agent}\r\n中文`)).toBe(agent);
  });
});
