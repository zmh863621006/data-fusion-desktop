export const HUIZHOU_MARKET_AUTHORITY = { name: '惠州市市场监督管理局', code: '11441300MB2C90987A' };

const districts = [
  ['惠城区', '惠州市惠城区市场监督管理局', '11441302351971239H'],
  ['惠阳区', '惠州市惠阳区市场监督管理局', '11441303MB2C47313U'],
  ['博罗县', '博罗县市场监督管理局', '114413223547593214'],
  ['龙门县', '龙门县市场监督管理局', '11441324MB2C20196D'],
  ['惠东县', '惠东县市场监督管理局', '11441323MB2C08058M'],
  ['大亚湾', '惠州大亚湾经济技术开发区管理委员会市场监督管理局', '11441300MB2E2413XP'],
  ['仲恺', '惠州仲恺高新技术产业开发区管理委员会市场监督管理局', '11441300MB2E23946P'],
] as const;

export function huizhouMarketAuthority(label: string): { name: string; code: string } | undefined {
  const match = districts.find(([district]) => label.includes(district));
  if (match) return { name: match[1], code: match[2] };
  if (label.includes(HUIZHOU_MARKET_AUTHORITY.name)) return HUIZHOU_MARKET_AUTHORITY;
}
