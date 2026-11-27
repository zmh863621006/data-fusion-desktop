/** Treat source identifiers as opaque text; the source does not require a fixed code length. */
export function normalizeHousingCode(value: string): string {
  const code = value.trim();
  if (!code || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(code)) throw new Error('请填写完整房屋编码，不能含空格、控制字符或不支持的符号');
  return code;
}
