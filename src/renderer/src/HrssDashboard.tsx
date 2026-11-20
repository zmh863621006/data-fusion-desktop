import { useState, type CSSProperties } from 'react';
import type { HrssCountBucket, HrssDashboardData } from '../../core/hrss/dashboard';
import './HrssDashboard.css';

export interface HrssDashboardProps {
  data: HrssDashboardData | null;
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void | Promise<void>;
  loading?: boolean;
  error?: string | null;
}
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN');
const percent = (value: number, total: number | null) => total ? `${Math.round(value / total * 100)}%` : '—';
const stamp = (value: number | null | undefined) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) : '尚无成功回流';
const width = (value: number, max: number): CSSProperties => ({ width: `${max ? value / max * 100 : 0}%` });

function Icon({ name }: { name: 'refresh' | 'close' | 'chart' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'refresh' && <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>}
    {name === 'close' && <path d="m6 6 12 12M6 18 18 6" />}
    {name === 'chart' && <><path d="M4 19V5m0 14h16M7 15l4-4 3 2 5-7" /></>}
  </svg>;
}
function Empty({ total, subject }: { total: number | null; subject: string }) {
  return <div className="hrss-empty"><Icon name="chart" /><strong>{total === null ? '等待首次回流' : '当前批次暂无记录'}</strong><span>{total === null ? `${subject}尚无成功批次` : '已成功回流，当前记录数为 0'}</span></div>;
}
function Bars({ items, total }: { items: HrssCountBucket[]; total: number | null }) {
  if (total === null || total === 0) return <Empty total={total} subject="对应台账" />;
  const max = Math.max(...items.map((item) => item.count), 1);
  return <ul className="hrss-bars">{items.map((item) => <li key={item.id}><div><span>{item.label}</span><strong>{number(item.count)}<small>{percent(item.count, total)}</small></strong></div><i><b style={width(item.count, max)} /></i></li>)}</ul>;
}
function Trend({ items, missing }: { items: HrssCountBucket[]; missing: number }) {
  if (!items.length) return <div className="hrss-empty"><Icon name="chart" /><strong>暂无可用申请日期</strong><span>{missing > 0 ? `${number(missing)} 条记录日期缺失或无效` : '申请日期回流后显示月度走势'}</span></div>;
  const shown = items.slice(-12), max = Math.max(...shown.map((item) => item.count), 1);
  const points = shown.map((item, index) => `${25 + index * 614 / Math.max(shown.length - 1, 1)},${160 - item.count / max * 124}`).join(' ');
  return <div className="hrss-trend" role="img" aria-label={shown.map((item) => `${item.label} ${item.count}条`).join('，')}>
    <svg viewBox="0 0 664 175" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="hrss-trend-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#007aff" stopOpacity=".2" /><stop offset="1" stopColor="#007aff" stopOpacity="0" /></linearGradient></defs>
      {[36, 77, 118, 160].map((y) => <line key={y} x1="25" x2="639" y1={y} y2={y} stroke="#e8edf4" strokeDasharray="4 5" />)}
      <polygon points={`25,160 ${points} 639,160`} fill="url(#hrss-trend-fill)" /><polyline points={points} fill="none" stroke="#007aff" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {shown.map((item, index) => <circle key={item.id} cx={25 + index * 614 / Math.max(shown.length - 1, 1)} cy={160 - item.count / max * 124} r="4" fill="white" stroke="#007aff" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
    </svg><div className="hrss-trend-months">{shown.map((item) => <span key={item.id}>{item.label.slice(2)}</span>)}</div>
    <p>{items.length > 12 ? '展示最近 12 个有记录的月份。' : '按列表申请日期归月。'}{missing > 0 ? ` ${number(missing)} 条日期缺失或无效。` : ''}</p></div>;
}

export function HrssDashboard({ data, onRefresh, onClose, loading = false, error }: HrssDashboardProps) {
  const [requestedView, setRequestedView] = useState<'subsidy' | 'service'>('subsidy');
  const subsidy = data?.subsidies, hasSubsidy = (subsidy?.matterCount ?? 0) > 0;
  const view = hasSubsidy && requestedView === 'subsidy' ? 'subsidy' : 'service';
  const matterCoverage = data?.matters.filter((matter) => matter.total !== null).length;
  const subsidyCoverage = subsidy?.matters.filter((matter) => matter.total !== null).length;
  const payable = subsidy?.paymentTotal ?? null;
  const paidAngle = payable ? subsidy!.paid / payable * 100 : 0;
  const awaitingAngle = payable ? (subsidy!.paid + subsidy!.awaitingPayment) / payable * 100 : 0;
  const donut: CSSProperties = { background: `conic-gradient(#007aff 0 ${paidAngle}%, #83bdff ${paidAngle}% ${awaitingAngle}%, #e8edf4 ${awaitingAngle}% 100%)` };
  const matterMax = Math.max(...(subsidy?.matters.map((matter) => matter.total ?? 0) ?? []), 1);
  return <main className="hrss-dashboard" aria-label="人社公共就业数据看板" aria-busy={loading}><div className="hrss-shell">
    <header className="hrss-header"><div><span className="hrss-eyebrow">广东人社 · 数据看板</span><h1>{view === 'subsidy' ? '就业创业补贴' : '公共就业服务'}</h1><p>已授权事项的数据概览</p></div><div className="hrss-header-actions"><span className="hrss-sync">●　{data ? `${number(matterCoverage)} / ${number(data.authorizedMatterCount)} 项已纳入统计` : '等待统计'}</span>{onRefresh && <button type="button" onClick={() => void onRefresh()} disabled={loading}><Icon name="refresh" />{loading ? '正在刷新' : '刷新统计'}</button>}{onClose && <button type="button" onClick={() => void onClose()} aria-label="关闭大屏"><Icon name="close" />关闭</button>}</div></header>
    <nav className="hrss-tabs" aria-label="看板主题">{hasSubsidy && <button type="button" aria-current={view === 'subsidy' ? 'page' : undefined} onClick={() => setRequestedView('subsidy')}>补贴总览</button>}<button type="button" aria-current={view === 'service' ? 'page' : undefined} onClick={() => setRequestedView('service')}>就业服务与台账</button></nav>
    {error && <div className="hrss-error" role="alert">本地统计暂时不可用，请刷新重试。</div>}
    {!data && <div className="hrss-loading" role="status"><Icon name="chart" /><h2>{loading ? '正在整理本地台账' : '尚无本地统计'}</h2><p>完成回流后可查看列表数据统计。</p></div>}
    {data && view === 'subsidy' && subsidy && <div className="hrss-content">
      <section className="hrss-kpis" aria-label="补贴概览"><article className="feature"><span>补贴申请记录</span><strong>{number(subsidy.total)}<small>条</small></strong><p>{subsidy.total === null ? '尚未同步，数值未知' : subsidy.total === 0 ? '当前成功批次记录数为 0' : '按申请记录计，跨事项不去重'}</p></article><article><span>支付成功</span><strong>{number(payable === null ? null : subsidy.paid)}<small>条</small></strong><p>支持支付统计的事项内占比 {percent(subsidy.paid, payable)}</p></article><article><span>待支付</span><strong>{number(payable === null ? null : subsidy.awaitingPayment)}<small>条</small></strong><p>列表支付状态明确为待支付</p></article><article><span>补贴事项覆盖</span><strong>{number(subsidyCoverage)}<em> / {number(subsidy.matterCount)}</em><small>项</small></strong><p>已纳入统计的授权事项</p></article></section>
      <div className="hrss-grid"><section className="hrss-panel hrss-matters"><div className="hrss-panel-head"><div><span>业务结构</span><h2>{number(subsidy.matterCount)} 类补贴申请量</h2><p>按当前授权事项统计</p></div><strong>{number(subsidy.total)}<small>条</small></strong></div>{subsidy.total === null || subsidy.total === 0 ? <Empty total={subsidy.total} subject="补贴事项" /> : <ul className="hrss-matter-bars">{subsidy.matters.map((matter) => <li key={matter.id}><div><span>{matter.name}</span><strong>{number(matter.total)}</strong></div><i><b style={width(matter.total ?? 0, matterMax)} /></i>{matter.total === null && <small>未回流</small>}</li>)}</ul>}</section>
      <section className="hrss-panel hrss-payment"><div className="hrss-panel-head"><div><span>办理进展</span><h2>支付状态结构</h2><p>支付成功 / 待支付 / 其他</p></div></div>{payable === null || payable === 0 ? <Empty total={payable} subject="支付状态" /> : <><div className="hrss-donut" style={donut}><div><strong>{percent(subsidy.paid, payable)}</strong><span>支付成功</span></div></div><div className="hrss-legend"><span><i className="paid" />成功 <b>{number(subsidy.paid)}</b></span><span><i className="awaiting" />待支付 <b>{number(subsidy.awaitingPayment)}</b></span><span><i className="other" />其他 <b>{number(subsidy.other)}</b></span></div></>}<p className="hrss-footnote">统计包含支付状态字段的事项，共 {number(payable)} 条记录。</p></section>
      <section className="hrss-panel hrss-monthly"><div className="hrss-panel-head"><div><span>时间趋势</span><h2>月度申请量</h2><p>按列表申请日期归月</p></div></div><Trend items={subsidy.monthly} missing={subsidy.missingApplyDate} /></section>
      <section className="hrss-panel hrss-areas"><div className="hrss-panel-head"><div><span>申领分布</span><h2>申请地街道</h2><p>只识别南山区 8 个街道</p></div></div><Bars items={subsidy.streets} total={subsidy.total} /></section>
      <section className="hrss-panel hrss-channels"><div className="hrss-panel-head"><div><span>办理渠道</span><h2>申请与比对渠道</h2><p>按申请渠道和扩岗数据来源归类</p></div></div><Bars items={subsidy.channels} total={subsidy.total} /></section>
      <section className="hrss-panel hrss-quality"><div className="hrss-panel-head"><div><span>数据质量</span><h2>当前统计口径</h2></div></div><div><p><strong>{number(subsidy.matterCount - (subsidyCoverage ?? 0))}</strong>项补贴事项尚无统计依据</p><p><strong>{number(subsidy.missingApplyDate)}</strong>条申请日期缺失或无效</p><p><strong>{number(subsidy.matters.filter((matter) => !matter.paymentSupported).length)}</strong>项列表无支付状态字段</p></div></section></div>
      <section className="hrss-detail-metrics" aria-label="补贴办理明细">
        {[
          { label: '平均支付用时', unit: '天', metric: subsidy.averagePaymentDays, basis: '从申请到支付成功，按自然日计算' },
          { label: '灵活就业补贴月数', unit: '月', metric: subsidy.flexibleSubsidyMonths, basis: '高校毕业生和就业困难人员补贴' },
          { label: '企业申报人次', unit: '人次', metric: subsidy.reportedApplicants, basis: '一次性扩岗和创业带动就业补贴' },
        ].map(({ label, unit, metric, basis }) => <article key={label}><span>{label}</span><strong>{number(metric.value)}<small>{unit}</small></strong><p>{basis} · {number(metric.recordCount)} 条有效记录</p></article>)}
      </section>
      <details className="hrss-ledger-details"><summary>查看补贴事项批次与查询范围</summary><Ledger data={data} onlySubsidies /></details>
    </div>}
    {data && view === 'service' && <div className="hrss-content">
      <section className="hrss-kpis" aria-label="就业服务概览">
        <article className="feature"><span>本地台账记录</span><strong>{number(data.totalRecords)}<small>条</small></strong><p>{data.totalRecords === null ? '尚无统计依据' : data.totalRecords === 0 ? '当前成功批次记录数为 0' : '跨台账不按人员去重'}</p></article>
        <article><span>已跟踪服务</span><strong>{number(data.tracking.total === null ? null : data.tracking.tracked)}<small>条</small></strong><p>三类人员跟踪台账</p></article>
        <article><span>事项统计覆盖</span><strong>{number(matterCoverage)}<em> / {number(data.authorizedMatterCount)}</em><small>项</small></strong><p>当前授权内的业务台账</p></article>
        <article><span>待处理超过 72 小时</span><strong>{number(data.aging.review.value)}<small>条</small></strong><p>列表滞留提示，非官方超期</p></article>
      </section>
      <div className="hrss-service-grid">
        <section className="hrss-panel"><div className="hrss-panel-head"><div><span>服务覆盖</span><h2>街道跟踪服务</h2></div></div><Bars items={data.tracking.streets.map((street) => ({ id: street.name, label: street.name, count: street.total }))} total={data.tracking.total} /></section>
        <section className="hrss-panel"><div className="hrss-panel-head"><div><span>人员构成</span><h2>年龄分布</h2></div></div><Bars items={data.ages.buckets} total={data.ages.total} /></section>
        <section className="hrss-panel"><div className="hrss-panel-head"><div><span>列表状态</span><h2>业务进展</h2></div></div><Bars items={data.statuses.buckets.filter((bucket) => bucket.count > 0)} total={data.statuses.total} /></section>
      </div>
      <section className="hrss-panel hrss-ledger-panel"><div className="hrss-panel-head"><div><span>统计依据</span><h2>已授权业务台账</h2></div></div><Ledger data={data} /></section>
    </div>}
    {data && <footer className="hrss-footer"><span><b>统计口径</b> · 按申请记录计，保留跨事项重复申请。</span><span>{data.lastSuccessAt !== null ? `最近成功 ${stamp(data.lastSuccessAt)}　·　` : ''}统计于 {stamp(data.generatedAt)}</span></footer>}
  </div></main>;
}

function Ledger({ data, onlySubsidies = false }: { data: HrssDashboardData; onlySubsidies?: boolean }) {
  const allowed = new Set(data.subsidies.matters.map((matter) => matter.id));
  return <div className="hrss-ledger" role="region" tabIndex={0} aria-label="已授权业务台账回流情况"><table><thead><tr><th>业务台账</th><th>记录数</th><th>回流状态</th><th>最近成功 / 查询范围</th></tr></thead><tbody>{data.matters.filter((matter) => !onlySubsidies || allowed.has(matter.id)).map((matter) => <tr key={matter.id}><th scope="row">{matter.name}</th><td>{number(matter.total)}</td><td>{matter.syncState === 'synced' ? '已回流' : matter.syncState === 'local-only' ? '仅本地记录' : '未回流'}{(matter.latestTaskStatus === 'failed' || matter.latestTaskStatus === 'cancelled') && <small>最近回流失败</small>}</td><td><time>{stamp(matter.lastSuccessAt)}</time>{matter.coverage && <small>查询 {matter.coverage.startDate ?? '起始不限'} — {matter.coverage.endDate ?? '结束不限'}</small>}</td></tr>)}</tbody></table></div>;
}
