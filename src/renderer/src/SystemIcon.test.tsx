import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SystemBadge, SystemIcon, systemIcon } from './AppIcon';

it('uses locally packaged source marks for the three verified systems', () => {
  for (const id of ['shenzhen-one-window', 'shenzhen-integrated-services', 'shenzhen-hazardous-chemicals']) {
    const html = renderToStaticMarkup(<SystemIcon id={id} size={20} />);
    expect(html).toContain(`data-source-system="${id}"`);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('aria-hidden="true"');
  }
  expect(renderToStaticMarkup(<SystemBadge id="shenzhen-one-window" />)).toContain('viewBox="8 324 69 62"');
});

it('gives each known system a business fallback without presenting it as an official mark', () => {
  for (const id of ['market-access', 'government-info', 'transport-practitioner', 'oversize-transport', 'online-car-permit',
    'guangdong-hrss', 'guangdong-population', 'guangdong-food-drug', 'guangdong-special-equipment',
    'shenzhen-integrated-services', 'shenzhen-hazardous-chemicals', 'shenzhen-one-window', 'shenzhen-housing-rental']) {
    expect(systemIcon(id)).not.toBe('components');
  }
  for (const id of ['shenzhen-housing-rental', 'guangdong-population', 'guangdong-food-drug']) {
    const html = renderToStaticMarkup(<SystemIcon id={id} />);
    expect(html).toContain('<svg'); expect(html).not.toContain('data-source-system');
  }
  expect(systemIcon('future-system')).toBe('components');
});
