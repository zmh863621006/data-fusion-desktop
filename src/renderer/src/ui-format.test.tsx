import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIcon, systemIcon } from './AppIcon';
import { taskProgressPercent, taskStatusLabel } from './ui-format';

describe('desktop presentation helpers', () => {
  it('keeps unknown statuses visible and localizes all existing task states', () => {
    expect(['queued', 'running', 'completed', 'failed', 'cancelled'].map(taskStatusLabel)).toEqual(['排队中', '进行中', '已完成', '失败', '已取消']);
    expect(taskStatusLabel('future-status')).toBe('future-status');
  });
  it('only reports a percentage when a denominator is actually known', () => {
    expect(taskProgressPercent({ current: 30 }, 'running')).toBeUndefined();
    expect(taskProgressPercent({ current: 30, total: 0 }, 'running')).toBeUndefined();
    expect(taskProgressPercent({ current: 3, total: 4 }, 'running')).toBe(75);
    expect(taskProgressPercent({ current: -1, total: 4 }, 'running')).toBe(0);
    expect(taskProgressPercent({ current: 8, total: 4 }, 'running')).toBe(100);
    expect(taskProgressPercent({ current: NaN, total: 4 }, 'running')).toBeUndefined();
    expect(taskProgressPercent({ current: 8, total: Infinity }, 'running')).toBeUndefined();
    expect(taskProgressPercent({ current: 0 }, 'completed')).toBe(100);
  });
  it('uses consistent code-native icons for all five systems, with an accessible fallback', () => {
    expect(['market-access', 'government-info', 'transport-practitioner', 'oversize-transport', 'online-car-permit'].map(systemIcon)).toEqual(['building', 'government', 'person', 'truck', 'car']);
    expect(systemIcon('future')).toBe('components');
    const html = renderToStaticMarkup(<button>系统组件<AppIcon name="components" /></button>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain('<img');
  });
});
