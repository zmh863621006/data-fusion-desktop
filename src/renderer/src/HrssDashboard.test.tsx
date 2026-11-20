import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildHrssDashboard } from '../../core/hrss/dashboard';
import { HrssDashboard } from './HrssDashboard';

const NOW = Date.parse('2026-11-04T04:00:00Z');
const matterId = 'unemployment-tracking-service';
const empty = () => buildHrssDashboard({ allowedMatterIds: [matterId], records: [], tasks: [], now: NOW });

describe('local HRSS dashboard presentation', () => {
  it('provides a readable initial loading state and accessible optional controls', () => {
    const html = renderToStaticMarkup(<HrssDashboard data={null} loading onRefresh={() => {}} onClose={() => {}} />);
    expect(html).toContain('正在整理本地台账');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="关闭大屏"');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<iframe');
  });

  it('distinguishes unsynced numbers from confirmed zero without showing fabricated population totals', () => {
    const unsynced = renderToStaticMarkup(<HrssDashboard data={empty()} />);
    expect(unsynced).toContain('尚无统计依据');
    expect(unsynced).toContain('等待首次回流');
    const zero = buildHrssDashboard({ allowedMatterIds: [matterId], records: [], tasks: [{ matterId, type: 'data-return', status: 'completed', finishedAt: NOW - 1_000 }], now: NOW });
    const synced = renderToStaticMarkup(<HrssDashboard data={zero} />);
    expect(synced).toContain('当前成功批次记录数为 0');
    expect(synced).toContain('已成功回流，当前记录数为 0');
    expect(synced).toContain('已授权事项的数据概览');
    expect(synced).not.toContain('尚无统计依据');
  });

  it('renders aggregate chart labels, missing evidence and latest failure while retaining successful data', () => {
    const data = buildHrssDashboard({
      allowedMatterIds: [matterId, 'job-seeking-startup-subsidy'], now: NOW,
      records: [
        { matterId, data: { belongArea: '南山区/粤海街道办事处', entryServiceSituation: '是', age: 30, name: 'synthetic-sensitive-name' } },
        { matterId: 'job-seeking-startup-subsidy', data: { currentLink: '待审核', applyDate: '2026-10-01', applyAddress: '粤海街道', applyChannel: '网站申请', payStatus: '待支付' } },
      ],
      tasks: [
        { matterId, type: 'data-return', status: 'completed', createdAt: NOW - 5_000, finishedAt: NOW - 4_000, details: { startDate: '2026-01-01', endDate: '2026-11-03' } },
        { matterId, type: 'data-return', status: 'failed', createdAt: NOW - 2_000, finishedAt: NOW - 1_000 },
      ],
    });
    const html = renderToStaticMarkup(<HrssDashboard data={data} />);
    expect(html).toContain('就业创业补贴');
    expect(html).toContain('支付状态结构');
    expect(html).toContain('粤海街道');
    expect(html).toContain('线上申请');
    expect(html).toContain('2026-10');
    expect(html).toContain('role="region"');
    expect(html).not.toContain('synthetic-sensitive-name');
    expect(html).not.toContain('学历');
  });

  it('shows a generic retry message and never reflects raw backend errors in the display', () => {
    const html = renderToStaticMarkup(<HrssDashboard data={empty()} error="raw-secret-or-identity" onRefresh={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('本地统计暂时不可用');
    expect(html).toContain('刷新统计');
    expect(html).not.toContain('raw-secret-or-identity');
  });
});
