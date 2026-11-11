/** Keep imported historical evidence visible even when an older record is not JSON. */
export function formatHistoryChange(before: string, after: string): string {
  const parse = (value: string): unknown => {
    try { return JSON.parse(value); }
    catch { return value; }
  };
  return JSON.stringify({ before: parse(before), after: parse(after) }, null, 2);
}

/** A compact, labelled filter band shared by all management lists. */
export const adminTableSearch = {
  labelWidth: 'auto' as const, layout: 'vertical' as const, span: 6,
  defaultCollapsed: false, collapseRender: false as const, searchGutter: 12,
  style: { padding: 0 },
};
