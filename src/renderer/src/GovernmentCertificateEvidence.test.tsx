import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { supplementCertificateFields } from '../../plugins/government-info/certificate-fields';
import { GovernmentCertificateEvidence } from './GovernmentCertificateEvidence';

describe('government certificate evidence display', () => {
  it('shows field paths and missing reasons without claiming a complete permit', () => {
    const data = supplementCertificateFields({}, { zjbh: '00123', zjmc: '**' });
    const html = renderToStaticMarkup(<GovernmentCertificateEvidence data={data} editing={false} />);
    expect(html).toContain('部分补充（非完整双公示）');
    expect(html).toContain('recordBean.primaryBean.zjbh');
    expect(html).toContain('接口值脱敏，未采用');
    expect(html).toContain('制证日期不等于许可决定日期');
    expect(html).not.toContain('<input');
  });
  it('warns that manual changes are not certified by previous import evidence', () => {
    const data = supplementCertificateFields({}, {}, true);
    const html = renderToStaticMarkup(<GovernmentCertificateEvidence data={data} editing />);
    expect(html).toContain('详情补充失败');
    expect(html).toContain('手工修改不会改写回流来源说明');
  });
  it('renders nothing for unverified matters or legacy records without metadata', () => {
    expect(renderToStaticMarkup(<GovernmentCertificateEvidence data={{}} editing={false} />)).toBe('');
  });
});
