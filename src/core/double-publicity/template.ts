export const DOUBLE_PUBLICITY_TEMPLATE = [
  ['xzxkmc', '许可项目名称'], ['xkXdrMc', '行政相对人名称'], ['xkXdrLb', '行政相对人类别'],
  ['xkXdrShxym', '行政相对人代码_1(统一社会信用代码)'], ['xkXdrGszc', '行政相对人代码_2 (工商注册号)'],
  ['xkXdrZzjg', '行政相对人代码_3(组织机构代码)'], ['xkXdrSwdj', '行政相对人代码_4(税务登记号)'],
  ['xkXdrSydw', '事业单位证书号'], ['xkXdrShzz', '社会组织登记证号'], ['xkFrdb', '法定代表人'],
  ['xkFrZjlx', '法定代表人证件类型'], ['xkFrZjhm', '法定代表人证件号码'], ['xkXdrZjlx', '自然人证件类型'],
  ['xkXdrZjhm', '自然人证件号码'], ['xkXkws', '行政许可决定文书名称'], ['xkWsh', '行政许可决定文书号'],
  ['xkXklb', '许可类别'], ['xkXkzs', '许可证书名称'], ['xkXkbh', '许可编号'], ['xkNr', '许可内容'],
  ['xkJdrq', '许可决定日期'], ['xkYxqz', '有效期自'], ['xkYxqzi', '有效期止'], ['xkXkjg', '许可机关'],
  ['xkXkjgdm', '许可机关统一社会信用代码'], ['xkZt', '当前状态'], ['xkLydw', '数据来源单位'],
  ['xkLydwdm', '数据来源单位统一社会信用代码'], ['xkSxjbbm', '事项基本编码'], ['xkSxssbm', '事项实施编码'],
  ['bz', '备注'],
] as const;

export const DOUBLE_PUBLICITY_KEYS = DOUBLE_PUBLICITY_TEMPLATE.map(([key]) => key);

export function isDoublePublicityData(data: Record<string, unknown>): boolean {
  return 'xzxkmc' in data && 'xkXdrMc' in data && 'xkJdrq' in data && 'xkXkjg' in data;
}
