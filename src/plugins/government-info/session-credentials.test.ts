import { describe, expect, it } from 'vitest';
import { selectEcsSid } from './session-credentials';

describe('government information session credentials', () => {
  it('selects the structured RPC sid instead of the short login id', () => {
    expect(selectEcsSid([
      'Oa8ryfYI',
      '67fc4b68a43f4b7ba512a7ecf82ab042I102C19P8001E',
    ])).toBe('67fc4b68a43f4b7ba512a7ecf82ab042I102C19P8001E');
  });

  it('falls back to the longest non-empty value for compatible deployments', () => {
    expect(selectEcsSid(['short', 'longer-session-value'])).toBe('longer-session-value');
    expect(selectEcsSid([])).toBeNull();
  });
});
