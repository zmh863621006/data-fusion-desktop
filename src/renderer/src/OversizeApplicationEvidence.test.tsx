import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OversizeApplicationEvidence } from './OversizeApplicationEvidence';
it('shows minimal application provenance without claiming the agent is the legal person', () => {
  const html = renderToStaticMarkup(<OversizeApplicationEvidence data={{ oversizeApplicationEnrichment: {
    status: 'matched', reason: '编号匹配', path: '/selectRequest', reqNo: 'B4413002026101260031', checkedAt: 1,
    creditCode: '91440300123456789Q', field: 'transportCreditCode',
  } }} />);
  expect(html).toContain('编号已匹配'); expect(html).toContain('transportCreditCode'); expect(html).toContain('经办人不是法人');
});
describe('missing and conflicting application evidence', () => {
  it('does not invent evidence for old records', () => expect(renderToStaticMarkup(<OversizeApplicationEvidence data={{}} />)).toBe(''));
  it('shows a conflict prominently', () => expect(renderToStaticMarkup(<OversizeApplicationEvidence data={{ oversizeApplicationEnrichment: {
    status: 'conflict', reason: '代码冲突', reqNo: 'B4413002026101260031', path: '/selectRequest', checkedAt: 1,
  } }} />)).toContain('待核对'));
});
