import { describe, expect, it } from 'vitest';
import shenzhenCatalog from '../../plugins/shenzhen-integrated-services/matter-catalog.json';
import { hasHandlingRecords, hasHrssHandlingRecords, handlingColumns, handlingCountLabel, hrssHandlingStatusLabel, readHandlingRecords } from './handling-records';

describe('case handling records shared by Guangdong and Shenzhen', () => {
  it('opens Shenzhen process history for its ten matters without widening the Guangdong gate', () => {
    for (const matter of shenzhenCatalog.matters) expect(hasHandlingRecords(shenzhenCatalog.id, matter.id)).toBe(true);
    expect(hasHandlingRecords(shenzhenCatalog.id, 'unregistered')).toBe(false);
    expect(hasHandlingRecords('other-system', shenzhenCatalog.matters[0].id)).toBe(false);
    expect(hasHandlingRecords('guangdong-hrss', 'startup-training')).toBe(true);
    expect(hasHandlingRecords('guangdong-hrss', 'unemployment')).toBe(false);
    expect(hasHrssHandlingRecords(shenzhenCatalog.id, shenzhenCatalog.matters[0].id)).toBe(false);
  });

  it('keeps separate people and timestamps, legitimate duplicate events and only declared fields', () => {
    const item = { operator: '操作甲', reviewer: '审批乙', operatedAt: '2026-10-01 08:00:00', reviewedAt: '2026-11-02 09:00:00',
      receivedAt: '2026-09-30 10:00:00', completedAt: '2026-11-03 11:00:00', publicityStartedAt: '2026-11-01 12:00:00',
      action: '受理', step: '受理环节', handledAt: '2026-11-02 09:00:00', organization: '', result: '公示通过', rawResult: '无异议',
      opinion: '核验通过', withdrawn: true, sourceRecordId: '', stageType: 'shouli', accessToken: 'SECRET', nested: { secret: 'SECRET' } };
    const result = readHandlingRecords([null, 'bad', item, { ...item }], shenzhenCatalog.id);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ operator: '操作甲', reviewer: '审批乙', operatedAt: item.operatedAt, reviewedAt: item.reviewedAt,
      receivedAt: item.receivedAt, completedAt: item.completedAt, publicityStartedAt: item.publicityStartedAt, withdrawn: true, rawResult: '无异议' });
    expect(result[1]).toEqual(result[0]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(handlingColumns(shenzhenCatalog.id).map(column => column.key)).toContain('reviewedAt');
    expect(handlingColumns('guangdong-hrss')).toHaveLength(7);
  });

  it('distinguishes an incomplete fetch from a confirmed empty process', () => {
    expect(handlingCountLabel(0, { handlingRecordStatus: 'failed', handlingRecords: [] })).toBe('待补齐');
    expect(handlingCountLabel(0, { handlingRecordStatus: 'failed', handlingRecords: [{}, {}] })).toBe('2（上次）');
    expect(handlingCountLabel(0, { handlingRecordStatus: 'collected', handlingRecords: [] })).toBe(0);
    expect(hrssHandlingStatusLabel('failed')).toBe('办理过程待补齐');
  });
});
