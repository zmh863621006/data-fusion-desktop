import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_FIELDS, certificateEvidenceText, mergeCertificateRecord, readCertificateEnrichment, supplementCertificateFields,
} from './certificate-fields';
import { MemoryLocalRepository } from '../../core/storage/memory-repository';
import { DefaultLocalSyncEngine, buildRecordKey } from '../../core/sync/engine';

const record = { cityLsh: 'CITY-TEST', sblsh: 'APPLY-TEST', sxmc: '测试事项', applyer: '导出完整主体', cardNumber: '导出完整号码' };

describe('neutral government certificate fields', () => {
  it('copies only verified strings, preserves leading zeroes, and does not infer permit semantics', () => {
    const source = { zjmc: ' 备案证明 ', zjbh: ' 00123 ', zzsj: '2026-09-01 10:11:12', zjyxqstart: '2026-09-02', zjyxqend: '长期',
      sqrmc: '脱*', sqrzjhm: '***', cbyj: '未经核实的正文' };
    const result = supplementCertificateFields(record, source);
    expect(result).toMatchObject({ ...record, certificateName: '备案证明', certificateNumber: '00123',
      certificateIssuedDate: source.zzsj, certificateValidFrom: source.zjyxqstart, certificateValidTo: '长期', fillStatus: '0' });
    for (const key of ['xkjdrq', 'xkJdrq', 'xkZt', 'xkCljg', 'xknr', 'xkXkjg', 'frdb', 'xydm', 'xkbh']) {
      expect(result).not.toHaveProperty(key);
    }
    const metadata = readCertificateEnrichment(result.certificateEnrichment)!;
    expect(metadata.status).toBe('partial');
    for (const { key, source: sourceKey } of CERTIFICATE_FIELDS) {
      expect(metadata.fields[key]).toEqual({ state: 'detail', method: 'WfGetRunningData', path: `recordBean.primaryBean.${sourceKey}` });
    }
    expect(source.zjbh).toBe(' 00123 ');
    expect(record).not.toHaveProperty('certificateName');
  });

  it.each([
    [undefined, 'not-returned'], [null, 'empty'], ['', 'empty'], ['  ', 'empty'], ['null', 'empty'], ['—', 'empty'],
    ['12***45', 'masked'], ['12＊＊45', 'masked'], ['●●●', 'masked'], [12345, 'invalid-type'],
    [{ time: 123 }, 'invalid-type'], [false, 'invalid-type'], [['证件号'], 'invalid-type'],
  ])('does not coerce unusable values (%j)', (value, reason) => {
    const result = supplementCertificateFields(record, { zjbh: value });
    expect(result).not.toHaveProperty('certificateNumber');
    expect(result).toMatchObject({ fillStatus: '0', certificateEnrichment: {
      status: 'empty', fields: { certificateNumber: { state: 'missing', reason } },
    } });
  });

  it('fills only holes and never overwrites existing complete values', () => {
    const input = { ...record, certificateName: '已有名称', certificateNumber: '已**', certificateValidTo: '长期' };
    const result = supplementCertificateFields(input, { zjmc: '新名称', zjbh: '00001', zjyxqend: '' });
    expect(result).toMatchObject({ certificateName: '已有名称', certificateNumber: '00001', certificateValidTo: '长期',
      certificateEnrichment: { fields: { certificateName: { state: 'existing' }, certificateNumber: { state: 'detail' } } } });
    expect(input.certificateNumber).toBe('已**');
  });

  it('keeps failure distinct from a successful response with absent fields', () => {
    const result = supplementCertificateFields({ ...record, certificateNumber: '本地号' }, {}, true);
    expect(result).toMatchObject({ certificateNumber: '本地号', certificateEnrichment: { status: 'failed',
      fields: { certificateName: { state: 'missing', reason: 'unavailable' } } } });
  });

  it('preserves local values and their local provenance on reflow, even when the remote differs', () => {
    const previous = supplementCertificateFields(record, { zjbh: '本地已有', zzsj: '2025-02-01' });
    const incoming = supplementCertificateFields({ ...record, currentLink: '办结' }, { zjbh: '接口新号' });
    const result = mergeCertificateRecord(incoming, previous);
    expect(result).toMatchObject({ certificateNumber: '本地已有', certificateIssuedDate: '2025-02-01', currentLink: '办结',
      certificateEnrichment: { status: 'partial', fields: { certificateNumber: { state: 'local' } } } });
    expect(incoming.certificateNumber).toBe('接口新号');
    expect(readCertificateEnrichment(incoming.certificateEnrichment)!.fields.certificateNumber.state).toBe('detail');
  });

  it.each(['cityLsh', 'sblsh', 'sxmc'])('does not combine local certificates across an identity conflict (%s)', (key) => {
    const incoming = supplementCertificateFields(record, {});
    expect(mergeCertificateRecord(incoming, { ...record, [key]: '不同', certificateNumber: '他人证件' }))
      .not.toHaveProperty('certificateNumber');
  });

  it('keeps partial fields in the real sync store after a subsequent detail failure', async () => {
    const repository = new MemoryLocalRepository();
    const engine = new DefaultLocalSyncEngine(repository);
    const initial = supplementCertificateFields(record, { zjbh: '00123', zjmc: '备案证' });
    const first = await engine.preview('government-info', 'test', ['cityLsh'], [initial], mergeCertificateRecord);
    await engine.commit('government-info', 'test', first);
    const failed = supplementCertificateFields(record, {}, true);
    const second = await engine.preview('government-info', 'test', ['cityLsh'], [failed], mergeCertificateRecord);
    await engine.commit('government-info', 'test', second);
    const key = buildRecordKey(record, ['cityLsh']);
    expect((await repository.find('government-info', 'test', key))?.data).toMatchObject({ certificateNumber: '00123',
      certificateEnrichment: { status: 'failed', fields: { certificateNumber: { state: 'local' } } } });
    expect(second.changes[0].current.certificateNumber).toBe('00123');
    expect(await repository.listVersions('government-info', 'test', key)).toHaveLength(2);
    const third = await engine.preview('government-info', 'test', ['cityLsh'], [failed], mergeCertificateRecord);
    expect(third).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it('ignores malformed metadata and provides readable field evidence', () => {
    for (const value of [null, '', [], {}, { version: 1, status: 'partial', fields: {} }]) {
      expect(readCertificateEnrichment(value)).toBeUndefined();
    }
    expect(certificateEvidenceText({ state: 'missing', reason: 'masked' })).toContain('脱敏');
    expect(certificateEvidenceText({ state: 'local' })).toContain('保留本地');
  });
});
