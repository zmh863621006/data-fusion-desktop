import { createHash, createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildTrainingCondition, buildTrainingListParameters, encodeTrainingCondition, enrichTrainingRecord, HRSS_TRAINING_HANDLING_CONFIG, HRSS_TRAINING_PROFILE, projectTrainingListRecord } from './training';

const progress = HRSS_TRAINING_PROFILE.sources[0], completed = HRSS_TRAINING_PROFILE.sources[1];
const session = { organizationId: '163374', whereKey: 'TESTKEY', csrfToken: 'TEST-CSRF' };
const caseRow = (source = completed, stage = '01') => ({
  XZ: `<input type="checkbox" name="${source === progress ? 'checkbox' : 'checkbox2'}" value="CASE-001|${stage}" />`,
  AAB004: `<a href="#" onclick="dw_view('CASE-001','${source === progress ? '10' : '20'}','');">测试培训单位&amp;机构</a>`,
  CCD002: 'APPLY-001', BCE089: '2026-11-01', XZQH: '南山区', BJRQ: '2026-11-24', BJJG: '审批通过', BCEA8W: '2026-11-25', BCEA8K: '支付成功', BCCA4S: '未追回',
  unlistedSecret: 'discard', attachment: { content: 'discard' },
});
const handlingRow = (number = 1) => ({ RN: number, ROWNUM_: number, _DIC_CDB042: '审核', BFE086: '审核通过', CFE006: '符合条件', JBR: '窗口人员', JBRQ: '2026-12-01 08:09:10', JBJG: '街道办', secret: 'discard' });

// Captured by running the original encrypt.js + cx_jd/cx_yw scripts with synthetic inputs in a VM.
// No production WHEREKEY, tokens, org session values, or business rows are stored in these fixtures.
const originalCipherFixtures = [
  { key: '1', plain: '1=1', encoded: '3133313a33303a38333a32353a3132303a3138303a3133353a3339' },
  { key: 'TESTKEY', plain: '1=1', encoded: '33333a3135343a353a33383a34353a3130353a3231333a313831' },
  { key: '1234567890123456789', plain: '1=1', encoded: '3136333a3232373a3132303a37333a3230363a3130373a3230363a313330' },
  { key: '123456789012345678901234', plain: '1=1', encoded: '38363a3133303a373a32383a39393a36363a32353a313936' },
  { key: 'TESTKEY', plain: '申请日期😀', encoded: '3138363a3135353a37373a353a3133323a38353a3131303a3234313a3135323a3234383a3130323a36313a35303a3231313a3139383a3738' },
];

function decodeFixtureCondition(value: unknown): string {
  const bytes = Buffer.from(String(value), 'hex').toString('ascii').split(':').map(Number);
  const key = Buffer.from('TESTKEYh', 'ascii');
  const cipher = createDecipheriv('des-ede3', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
  const plain = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  let result = ''; for (let i = 0; i < plain.length; i += 2) result += String.fromCharCode(plain.readUInt16BE(i));
  return result.replace(/\0+$/, '');
}

describe('创业培训旧版列表条件', () => {
  it('matches original encryption fixtures for short/long keys, UTF-16 surrogate pairs, and padding', () => {
    for (const fixture of originalCipherFixtures) expect(encodeTrainingCondition(fixture.key, fixture.plain)).toBe(fixture.encoded);
    expect(encodeTrainingCondition('TESTKEY', '')).toBe('');
  });
  it('preserves both original organization scopes and sends selected BCE089 application dates', () => {
    const progressParameters = buildTrainingListParameters(progress, 1, '2026-11-01', '2026-11-25', session);
    const completedParameters = buildTrainingListParameters(completed, 2, '2026-11-01', '2026-11-25', session);
    expect(progressParameters).toMatchObject({ confid: 'jycyzjgl_cypxbt_cxjd_bljdcxjglb', rowstart: 1, pageSize: 200 });
    expect(completedParameters).toMatchObject({ confid: 'jycyzjgl_cypxbt_cxjd_bjywcxjglb', rowstart: 201, pageSize: 200 });
    expect(createHash('sha256').update(String(progressParameters.whereCls)).digest('hex')).toBe('2f6d30052df6955218031f02a83f3a1dc23e57d2307f9c9500f975cd82190ff0');
    expect(createHash('sha256').update(String(completedParameters.whereCls)).digest('hex')).toBe('727a73cf820f7dee46e9ac95122a0e2f0fad8203306421a60b4cd16704d4ae4d');
    const decoded = decodeFixtureCondition(progressParameters.whereCls);
    expect(decoded).toContain("t.BZE382 = 'BT_CYPXBT'"); expect(decoded).toContain("instr(t.BZD411,',163374,')");
    expect(decoded).toContain("instr(b.ORGPARENT,',163374,')"); expect(decoded).toContain("(cdb043 <> '04' or cdb043 is null)");
    expect(decoded).toContain("BCE089 >= '2026-11-01' and BCE089 <= '2026-11-25'");
    expect(JSON.stringify(progressParameters)).not.toContain('TEST-CSRF');
  });
  it('rejects malformed dates, identifiers, unexpected sources and pagination without constructing arbitrary conditions', () => {
    expect(() => buildTrainingListParameters(progress, 1, "2026-11-01' or 1=1", '2026-11-25', session)).toThrow('有效');
    expect(() => buildTrainingListParameters(progress, 1, '2026-11-25', '2026-11-01', session)).toThrow('不能晚于');
    expect(() => buildTrainingCondition(progress, '2026-11-01', '2026-11-25', { ...session, organizationId: "1' or 1=1" })).toThrow('经办机构');
    expect(() => buildTrainingListParameters(progress, 0, '2026-11-01', '2026-11-25', session)).toThrow('分页');
    expect(() => buildTrainingListParameters({ ...progress, id: 'other' }, 1, '2026-11-01', '2026-11-25', session)).toThrow('来源');
    expect(() => encodeTrainingCondition('', '1=1')).toThrow('密钥');
  });
});

describe('创业培训列表与办理记录投影', () => {
  it('recognizes fixed list checkbox/link identifiers and keeps only visible declared list values', () => {
    expect(projectTrainingListRecord(completed, caseRow())).toEqual({ caseId: 'CASE-001', unitName: '测试培训单位&机构', applyBh: 'APPLY-001', applyDate: '2026-11-01', applyAddress: '南山区', currentLink: '已办结', completedDate: '2026-11-24', completedResult: '审批通过', payDate: '2026-11-25', payStatus: '支付成功', recoveryStatus: '未追回' });
    expect(projectTrainingListRecord(progress, caseRow(progress, 'BT_SH')).currentLink).toBe('待审核');
    expect(projectTrainingListRecord(progress, caseRow(progress, 'BT_SP')).currentLink).toBe('待审批');
    const lowerCaseProgress=caseRow(progress,'BT_SH');
    expect(projectTrainingListRecord(progress,{...lowerCaseProgress,XZ:undefined,xz:lowerCaseProgress.XZ}).currentLink).toBe('待审核');
  });
  it('retains BT_SL progress cases with zero history requests and rejects unknown/contradictory statuses', async () => {
    const requestTrainingList = vi.fn();
    expect(await enrichTrainingRecord({ requestTrainingList }, progress, caseRow(progress, 'BT_SL'), session)).toEqual({handlingRecordCount:0,handlingRecordStatus:'skipped-pending',handlingRecords:[]});
    expect(requestTrainingList).not.toHaveBeenCalled();
    await expect(enrichTrainingRecord({ requestTrainingList }, progress, caseRow(progress, 'UNKNOWN'), session)).rejects.toThrow('办理状态');
    await expect(enrichTrainingRecord({ requestTrainingList }, progress, { ...caseRow(progress, 'BT_SH'), BHEA81: 'BT_SL' }, session)).rejects.toThrow('状态不一致');
    await expect(enrichTrainingRecord({ requestTrainingList }, progress, { ...caseRow(progress, 'BT_SH'), BHEA81: '待受理' }, session)).rejects.toThrow('状态不一致');
    await expect(enrichTrainingRecord({ requestTrainingList }, progress, { ...caseRow(progress, 'BT_SL'), BHEA81: '待审核' }, session)).rejects.toThrow('状态不一致');
    expect(projectTrainingListRecord(progress,{...caseRow(progress,'BT_SH'),BHEA81:'待审核'}).currentLink).toBe('待审核');
    expect(requestTrainingList).not.toHaveBeenCalled();
  });
  it('never evaluates handler JavaScript and rejects mismatched or unsafe business identifiers', () => {
    expect(() => projectTrainingListRecord(completed, { ...caseRow(), AAB004: '<a onclick="dw_view(\'CASE-001\',\'20\',\'\');globalThis.injected=true">单位</a>' })).toThrow('链接');
    expect(() => projectTrainingListRecord(completed, { ...caseRow(), XZ: '<input value="OTHER|01" />' })).toThrow('编号');
    expect(() => projectTrainingListRecord(completed, { ...caseRow(), XZ: '<input value="MASKED***|01" />' })).toThrow('编号');
    expect(() => projectTrainingListRecord(completed, { XZ: '', AAB004: '只有名称' })).toThrow('编号');
  });
  it('fetches only the confirmed handling grid with all handling dates and whitelists its fields', async () => {
    const requestTrainingList = vi.fn(async (_params: Record<string, unknown>, _signal?: AbortSignal) => ({ total: 1, rows: [handlingRow()] }));
    const result = await enrichTrainingRecord({ requestTrainingList }, completed, caseRow(), session);
    expect(requestTrainingList).toHaveBeenCalledOnce();
    const [params] = requestTrainingList.mock.calls[0];
    expect(params).toMatchObject({ confid: HRSS_TRAINING_HANDLING_CONFIG, rowstart: 1, pageSize: 200 });
    expect(decodeFixtureCondition(params.whereCls)).toBe(" CDB041 = 'CASE-001' and BZE453='1' ");
    expect(result).toEqual({ handlingRecordCount: 1, handlingRecordStatus: 'collected', handlingRecords: [{ step: '审核', result: '审核通过', opinion: '符合条件', operator: '窗口人员', handledAt: '2026-12-01 08:09:10', organization: '街道办', action: '' }] });
  });
  it('retains distinct identical-content log rows and collects every page using legacy row offsets', async () => {
    const first = Array.from({ length: 200 }, (_, i) => handlingRow(i + 1));
    const requestTrainingList = vi.fn().mockResolvedValueOnce({ total: 201, rows: first }).mockResolvedValueOnce({ total: 201, rows: [handlingRow(201)] });
    const result = await enrichTrainingRecord({ requestTrainingList }, completed, caseRow(), session);
    expect(result?.handlingRecords).toHaveLength(201);
    expect(requestTrainingList.mock.calls[1][0]).toMatchObject({ rowstart: 201, pageSize: 200 });
  });
  it('rejects partial, changed, repeated or unidentifiable pages rather than saving a partial history', async () => {
    const short = vi.fn(async () => ({ total: 2, rows: [handlingRow()] }));
    await expect(enrichTrainingRecord({ requestTrainingList: short }, completed, caseRow(), session)).rejects.toThrow('分页条数');
    const repeated = vi.fn(async () => ({ total: 2, rows: [handlingRow(), handlingRow()] }));
    await expect(enrichTrainingRecord({ requestTrainingList: repeated }, completed, caseRow(), session)).rejects.toThrow('重复');
    const missing = vi.fn(async () => ({ total: 1, rows: [{ ...handlingRow(), RN: undefined, ROWNUM_: undefined }] }));
    await expect(enrichTrainingRecord({ requestTrainingList: missing }, completed, caseRow(), session)).rejects.toThrow('行号');
    const changed = vi.fn().mockResolvedValueOnce({ total: 201, rows: Array.from({ length: 200 }, (_, i) => handlingRow(i + 1)) }).mockResolvedValueOnce({ total: 202, rows: [handlingRow(201)] });
    await expect(enrichTrainingRecord({ requestTrainingList: changed }, completed, caseRow(), session)).rejects.toThrow('总数发生变化');
  });
  it('accepts explicit empty histories, propagates errors, and checks cancellation before and after requests', async () => {
    expect(await enrichTrainingRecord({ requestTrainingList: vi.fn(async () => ({ total: 0, rows: [] })) }, completed, caseRow(), session)).toMatchObject({ handlingRecordCount: 0, handlingRecords: [] });
    await expect(enrichTrainingRecord({ requestTrainingList: vi.fn(async () => { throw new Error('读取记录失败'); }) }, completed, caseRow(), session)).rejects.toThrow('读取记录失败');
    const before = new AbortController(); before.abort(); const requestTrainingList = vi.fn();
    await expect(enrichTrainingRecord({ requestTrainingList }, completed, caseRow(), session, before.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(requestTrainingList).not.toHaveBeenCalled();
    const during = new AbortController();
    await expect(enrichTrainingRecord({ requestTrainingList: vi.fn(async () => { during.abort(); return { total: 0, rows: [] }; }) }, completed, caseRow(), session, during.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });
});
