import { describe, expect, it } from 'vitest';
import { releaseTrustedKey } from './release-trust';

describe('release trust root', () => {
  it('ignores environment key overrides in a shipped build', () => {
    expect(releaseTrustedKey('embedded-product-key', 'untrusted-self-signed-key', false)).toBe('embedded-product-key');
  });
  it('allows isolated signing fixtures in development only', () => {
    expect(releaseTrustedKey('embedded-product-key', 'test-key', true)).toBe('test-key');
  });
  it('falls back to the embedded key without a development override', () => {
    expect(releaseTrustedKey('embedded-product-key', undefined, true)).toBe('embedded-product-key');
    expect(releaseTrustedKey('embedded-product-key', '', true)).toBe('embedded-product-key');
  });
});
