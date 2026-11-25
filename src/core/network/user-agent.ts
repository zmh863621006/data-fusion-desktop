/** Keep the real browser/runtime versions while avoiding Unicode HTTP product names. */
export function businessRequestUserAgent(userAgent: string): string {
  return userAgent
    .replace(/(^|\s)([^\s/]+)\/([^\s]+)/g, (product, separator: string, name: string, version: string) =>
      /[^\x21-\x7e]/.test(name) ? `${separator}DataFusion/${version}` : product)
    .replace(/[^\x20-\x7e]/g, '');
}
