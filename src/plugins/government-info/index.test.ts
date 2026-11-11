import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }));
import { governmentInfoPlugin } from './index';
import { validateFilters } from '../../core/query/validation';

describe('government matter submission', () => {
  it('opts only the five partial matters into non-destructive certificate merging', () => {
    const matters = governmentInfoPlugin.matters.filter((matter) => matter.mergeRecord);
    expect(matters).toHaveLength(5);
    for (const matter of matters) expect(matter.description).toContain('不表示完整双公示');
    expect(governmentInfoPlugin.matters.find((matter) => matter.id === 'teacher-qualification')?.mergeRecord).toBeUndefined();
    expect(governmentInfoPlugin.matters.find((matter) => matter.id === 'drainage-permit-new')?.mergeRecord).toBeUndefined();
  });
  it('accepts every default context through the same validation as IPC', () => {
    expect(governmentInfoPlugin.matters).toHaveLength(18);
    for (const matter of governmentInfoPlugin.matters) {
      expect(() => validateFilters(matter.querySchema, matter.createDefaultContext!().filters)).not.toThrow();
    }
  });
});
