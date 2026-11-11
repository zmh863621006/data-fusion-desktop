import { describe, expect, it } from 'vitest';
import { formatHistoryChange } from './presentation';

describe('enterprise history presentation', () => {
  it('preserves original before/after values and Unicode names', () => {
    const value = JSON.parse(formatHistoryChange('{"name":"原始 企业","code":"001"}', '{"name":"标准企业","legalPerson":"张某"}'));
    expect(value.before).toEqual({ name: '原始 企业', code: '001' });
    expect(value.after).toEqual({ name: '标准企业', legalPerson: '张某' });
  });

  it('keeps malformed legacy evidence visible without breaking the drawer', () => {
    const value = JSON.parse(formatHistoryChange('legacy raw text', '{invalid json'));
    expect(value.before).toBe('legacy raw text');
    expect(value.after).toBe('{invalid json');
  });

  it('preserves null, arrays and empty historical evidence', () => {
    expect(JSON.parse(formatHistoryChange('null', '[0,false,"old"]'))).toEqual({ before: null, after: [0, false, 'old'] });
    expect(JSON.parse(formatHistoryChange('', '""'))).toEqual({ before: '', after: '' });
  });
});
