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
  expect(render({ handlingRecordStatus: 'skipped-pending', handlingRecords: [] })).toContain('该办件为待受理，已保留在业务列表中，暂无办理记录');
  expect(render({ handlingRecordStatus: 'skipped-pending', handlingRecords: [] })).toContain('共 0 条');
  expect(render({ handlingRecordStatus: 'collected', handlingRecords: [] })).toContain('原系统未返回办理记录');
  expect(render({})).toContain('请重新回流后查看');
});

it('restricts workflow history to the four human-resources street matters and rejects nested display values', () => {
  expect(hasHrssHandlingRecords('guangdong-hrss', 'startup-training')).toBe(true);
  expect(hasHrssHandlingRecords('guangdong-hrss', 'unemployment')).toBe(false);
  expect(hasHrssHandlingRecords('another-system', 'startup-training')).toBe(false);
  expect(hrssDisplayValue({ key: 'handlingRecordStatus', label: '采集状态' }, 'skipped-pending')).toBe('待受理，暂无办理记录');
  expect(hrssDisplayValue({ key: 'untrusted', label: '测试' }, { token: 'SECRET' })).toBe('—');
  expect(readHrssHandlingRecords([null, 'bad', [], { operator: { secret: 'SECRET' }, action: '通过', unknown: 'SECRET' }])).toEqual([
    { operator: '', organization: '', handledAt: '', step: '', action: '通过', result: '', opinion: '' },
  ]);
});

it('shows Shenzhen application-only cases with separate operators, reviewers and every process timestamp', () => {
  const markup = renderToStaticMarkup(<HrssHandlingRecords systemId="shenzhen-integrated-services" data={{
    caseNumber: 'TEST-APPLICATION-001', applicationNumber: 'TEST-APPLICATION-001', processNumber: '', subjectName: '测试单位', receivedAt: '2026-11-01 08:00:00',
    businessState: '受理不通过', handlingRecordStatus: 'collected', handlingRecords: [
      { operator: '申请甲', reviewer: '', receivedAt: '2026-10-01 08:01:00', operatedAt: '2026-10-01 08:02:00', reviewedAt: '', completedAt: '2026-10-01 08:03:00',
        publicityStartedAt: '', step: '申请环节', action: '申请', result: '', opinion: '', withdrawn: false },
      { operator: '操作乙', reviewer: '审批丙', receivedAt: '2026-11-01 09:01:00', operatedAt: '2026-11-01 09:02:00', reviewedAt: '2026-11-01 09:03:00',
        completedAt: '2026-11-01 09:04:00', publicityStartedAt: '2026-11-02 09:05:00', step: '受理环节', action: '受理', result: '受理不通过', opinion: '请核对资料', withdrawn: true, token: 'SECRET' },
    ],
  }} onClose={() => {}} />);
  expect(markup).toContain('共 2 条'); expect(markup).toContain('TEST-APPLICATION-001');
  for (const text of ['操作人', '审批人', '操作时间', '审批时间', '环节接收时间', '完成时间', '公示开始时间',
    '2026-10-01 08:01:00', '2026-11-01 09:02:00', '2026-11-01 09:03:00', '2026-11-01 09:04:00', '2026-11-02 09:05:00', '按所选日期筛选办件']) expect(markup).toContain(text);
  expect(markup).toContain('role="region"'); expect(markup).toContain('tabindex="0"');
  expect(markup).not.toContain('SECRET'); expect(markup).not.toContain('操作乙'); expect(markup).not.toContain('审批丙');
});

it('shows incomplete Shenzhen history without claiming zero completed records, while preserving old events', () => {
  const render = (records: unknown[]) => renderToStaticMarkup(<HrssHandlingRecords systemId="shenzhen-integrated-services" data={{
    handlingRecordStatus: 'failed', handlingRecordError: 'SECRET', handlingRecords: records,
  }} onClose={() => {}} />);
  const empty = render([]);
  expect(empty).toContain('办理过程待补齐'); expect(empty).not.toContain('共 0 条'); expect(empty).not.toContain('原系统未返回');
  const previous = render([{ operator: '上次经办', action: '受理', step: '已采集环节', operatedAt: '2026-11-01 09:00:00' }]);
  expect(previous).toContain('保留上次 1 条记录'); expect(previous).toContain('已采集环节'); expect(previous).not.toContain('SECRET');
  expect(hrssDisplayValue({ key: 'handlingRecordCount', label: '记录数' }, 0, { handlingRecordStatus: 'failed', handlingRecords: [] })).toBe('待补齐');
});
