import { describe, expect, it } from 'vitest';
import { HAZCHEM_PUBLICATION_PLATFORMS, PUBLICATION_PLATFORMS, publicationPlatform, publicationPlatformsForSystem, sourceTabOwner } from './platforms';

describe('source-authorized publication platforms', () => {
  it('provides the same two fixed destinations under each source system grant with separate tab identities', () => {
    const government = publicationPlatformsForSystem('government-info');
    const hazchem = publicationPlatformsForSystem('shenzhen-hazardous-chemicals');
    expect(government).toEqual(Object.values(PUBLICATION_PLATFORMS));
    expect(hazchem).toEqual(Object.values(HAZCHEM_PUBLICATION_PLATFORMS));
    expect(hazchem.map(platform => platform.url)).toEqual(government.map(platform => platform.url));
    expect(new Set([...government, ...hazchem].map(platform => platform.partition)).size).toBe(4);
    expect(publicationPlatformsForSystem('guangdong-hrss')).toEqual([]);
  });
  it('resolves only fixed platform IDs and binds reopening to the source permission', () => {
    expect(sourceTabOwner('hazchem-nanshan-publicity')).toBe('shenzhen-hazardous-chemicals');
    expect(sourceTabOwner('nanshan-publicity')).toBe('government-info');
    expect(publicationPlatform('hazchem-guangdong-law-publicity')?.allowedOrigin).toBe('https://xtbg.gdzwfw.gov.cn');
    expect(publicationPlatform('https://example.com')).toBeUndefined();
    expect(publicationPlatform('__proto__')).toBeUndefined();
  });
});
