import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HrssHandlingRecords } from './HrssHandlingRecords';
import { hrssDisplayValue } from './HrssLedgerPage';
import { hasHrssHandlingRecords, readHrssHandlingRecords } from '../../core/hrss/handling-records';

it('renders every saved handling record with separate step/action and masks operators', () => {
  const markup = renderToStaticMarkup(<HrssHandlingRecords data={{ applyBh: 'TEST-001', unitName: '测试单位', applyDate: '2026-10-01',
    handlingRecordStatus: 'collected', handlingRecords: [
      { operator: '测试甲', organization: '受理部门', handledAt: '2026-10-01 09:00', step: '受理', action: '通过', result: '', opinion: '核验通过', accessToken: 'SECRET' },
      { operator: '测试乙', organization: '审核部门', handledAt: '2026-11-20 10:00', step: '审核', action: '办结', result: '通过', opinion: '后续记录' },
    ] }} onClose={() => {}} />);
  expect(markup).toContain('role="dialog"'); expect(markup).toContain('aria-modal="true"');
  expect(markup).toContain('共 2 条'); expect(markup).toContain('2026-11-20 10:00');
  expect(markup).toContain('办理环节'); expect(markup).toContain('办理操作');
  expect(markup).toContain('测**'); expect(markup).not.toContain('测试甲'); expect(markup).not.toContain('测试乙');
  expect(markup).not.toContain('SECRET'); expect(markup).not.toContain('[object Object]');
});

it('distinguishes pending cases, empty remote history and old unsampled records', () => {
  const render = (data: Record<string, unknown>) => renderToStaticMarkup(<HrssHandlingRecords data={data} onClose={() => {}} />);
  expect(render({ handlingRecordStatus: 'skipped-pending', handlingRecords: [] })).toContain('该办件为待受理，本批次未查询其办理记录');
  expect(render({ handlingRecordStatus: 'collected', handlingRecords: [] })).toContain('原系统未返回办理记录');
  expect(render({})).toContain('请重新回流后查看');
});

it('restricts workflow history to the four human-resources street matters and rejects nested display values', () => {
  expect(hasHrssHandlingRecords('guangdong-hrss', 'startup-training')).toBe(true);
  expect(hasHrssHandlingRecords('guangdong-hrss', 'unemployment')).toBe(false);
  expect(hasHrssHandlingRecords('another-system', 'startup-training')).toBe(false);
  expect(hrssDisplayValue({ key: 'handlingRecordStatus', label: '采集状态' }, 'skipped-pending')).toBe('待受理，未查询办理记录');
  expect(hrssDisplayValue({ key: 'untrusted', label: '测试' }, { token: 'SECRET' })).toBe('—');
  expect(readHrssHandlingRecords([null, 'bad', [], { operator: { secret: 'SECRET' }, action: '通过', unknown: 'SECRET' }])).toEqual([
    { operator: '', organization: '', handledAt: '', step: '', action: '通过', result: '', opinion: '' },
  ]);
});
