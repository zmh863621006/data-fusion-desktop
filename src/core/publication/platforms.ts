/** Fixed login destinations only. Opening a platform does not submit batch data. */
export const PUBLICATION_PLATFORMS = {
  'nanshan-publicity': {
    id: 'nanshan-publicity',
    name: '南山区公共信用信息服务与监管平台',
    tabName: '南山双公示',
    buttonLabel: '报送南山双公示',
    ownerSystemId: 'government-info',
    url: 'https://nsxy.szns.gov.cn/credit/#/home',
    allowedOrigin: 'https://nsxy.szns.gov.cn',
    partition: 'persist:publication-nanshan',
  },
  'guangdong-law-publicity': {
    id: 'guangdong-law-publicity',
    name: '广东省行政执法信息公示平台公示管理系统',
    tabName: '省行政执法双公示',
    buttonLabel: '报送省行政执法双公示',
    ownerSystemId: 'government-info',
    url: 'https://xtbg.gdzwfw.gov.cn/orgDev/rz/index.html?appid=wl2bee594e73&agentid=1000562&redirect_uri=https%3A%2F%2Fxtbg.gdzwfw.gov.cn%2F_tif_wwlocal_login_%2F%3Furl%3Dhttps%253A%252F%252Fxtbg.gdzwfw.gov.cn%252Fgdxzzfpc%252FApprLawCollection%252Findex.html&state=gdxzzfpc#/workbench',
    allowedOrigin: 'https://xtbg.gdzwfw.gov.cn',
    partition: 'persist:publication-guangdong-law',
  },
} as const;

// Keep the source-system permission attached to a publication tab for its
// entire lifetime. Separate IDs prevent another system's grant from reopening
// a tab after the original source grant has been removed.
export const HAZCHEM_PUBLICATION_PLATFORMS = {
  'hazchem-nanshan-publicity': {
    ...PUBLICATION_PLATFORMS['nanshan-publicity'],
    id: 'hazchem-nanshan-publicity', ownerSystemId: 'shenzhen-hazardous-chemicals',
    partition: 'persist:publication-hazchem-nanshan',
  },
  'hazchem-guangdong-law-publicity': {
    ...PUBLICATION_PLATFORMS['guangdong-law-publicity'],
    id: 'hazchem-guangdong-law-publicity', ownerSystemId: 'shenzhen-hazardous-chemicals',
    partition: 'persist:publication-hazchem-guangdong-law',
  },
} as const;

const ALL_PUBLICATION_PLATFORMS = { ...PUBLICATION_PLATFORMS, ...HAZCHEM_PUBLICATION_PLATFORMS } as const;
export type PublicationPlatformId = keyof typeof ALL_PUBLICATION_PLATFORMS;

export function publicationPlatformsForSystem(systemId: string) {
  return Object.values(ALL_PUBLICATION_PLATFORMS).filter(platform => platform.ownerSystemId === systemId);
}

export function publicationPlatform(id: unknown) {
  return typeof id === 'string' && Object.hasOwn(ALL_PUBLICATION_PLATFORMS, id)
    ? ALL_PUBLICATION_PLATFORMS[id as PublicationPlatformId] : undefined;
}

export const sourceTabOwner = (id: string): string => publicationPlatform(id)?.ownerSystemId ?? id;
