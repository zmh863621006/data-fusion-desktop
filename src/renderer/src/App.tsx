import { PractitionerNumberPanel } from './PractitionerNumberPanel';
import { PRACTITIONER_NUMBER_MATTERS } from '../../core/config/practitioner-numbers';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SourceTabsState } from '../../core/session/source-tabs';
import { DOUBLE_PUBLICITY_TEMPLATE } from '../../core/double-publicity/template';
import { validateExport } from '../../core/double-publicity/validation';
import type { OperationalLogEntry, OperationalLogLevel } from '../../core/diagnostics/types';
import { CERTIFICATE_FIELDS } from '../../plugins/government-info/certificate-fields';
import { GovernmentCertificateEvidence } from './GovernmentCertificateEvidence';
import { OversizeApplicationEvidence } from './OversizeApplicationEvidence';
import { HealthPublicityPage } from './HealthPublicityPage';
import { ExportNotice, type ExportResult } from './ExportNotice';
import { AppIcon, BrandMark, SystemBadge, systemIcon } from './AppIcon';
import { Modal } from './Modal';
import { PageSizeOptions } from './PageSizeOptions';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../core/settings/types';
import { shortSystemName, systemDescription, taskProgressPercent, taskStatusLabel } from './ui-format';
import type { LicenseStatus } from '../../core/license/types';
import { workspaceAccess, type AppPage } from './workspace-access';
import { UpdateBanner, UpdateStatus, useUpdateState } from './UpdateStatus';
import type { ComponentSummary } from '../../core/plugins/components';
import { ComponentCatalog } from './ComponentCatalog';
import { publicationPlatform, publicationPlatformsForSystem, type PublicationPlatformId } from '../../core/publication/platforms';
import { HrssLedgerPage, type HrssListColumn } from './HrssLedgerPage';
import { BatchPageOptions, selectBatchOption, useCompletedBatches } from './useCompletedBatches';
import { HrssDashboardWindowPage } from './HrssDashboardWindowPage';
import { HrssDateNotice } from './HrssDateNotice';
import { hrssTaskDateLabel } from '../../core/hrss/date-filters';
import { GOVERNMENT_EXPORT_LABELS, supportsGovernmentExport, type GovernmentExportTarget } from '../../core/export/government-target';
import { EQUIPMENT_SYSTEM_ID, USE_REGISTRATION } from '../../plugins/guangdong-special-equipment/catalog';
import type { QueryPage } from '../../core/query/types';

type SessionState = {
  status: 'logged-out' | 'logging-in' | 'authenticated' | 'unverified' | 'expiring' | 'expired';
  systemId: string;
  expiresAt?: number;
  displayName?: string;
  message?: string;
};

type SystemSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
  workspaceMode?: 'standard' | 'return-ledger' | 'list-ledger';
  supportsCredentialConfiguration?: boolean;
  session: SessionState;
};

type QueryFieldSchema = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'date-range' | 'select' | 'multi-select';
  required?: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string | number }>;
};

type MatterSummary = {
  id: string;
  name: string;
  departmentId?: string;
  departmentName?: string;
  departmentOrder?: number;
  matterOrder?: number;
  description?: string;
  querySchema: QueryFieldSchema[];
  uniqueKey: string[];
  executionMode?: 'interactive-query' | 'one-click-return';
  defaultFilters?: Record<string, unknown>;
  listColumns?: readonly HrssListColumn[];
  dateFilter?: { mode: 'applied' | 'pending'; message: string };
};

type SyncPreview = {
  previewId: string;
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
};

type MatterSection = 'return' | 'tasks' | 'data';

const RECORD_LIST_COLUMN_KEYS = ['xzxkmc', 'xkXdrMc', 'xkXdrShxym', 'xkXdrZjhm', 'xkWsh', 'xkJdrq', 'xkYxqz', 'xkYxqzi'] as const;
const hasDisplayValue = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== '';
const sessionLabel = (state?: SessionState) => state?.status === 'authenticated' ? '业务系统已登录'
  : state?.status === 'unverified' ? '会话已保留，暂时无法验证'
  : state?.status === 'expired' ? '登录已失效，请重新登录' : '业务系统未登录';

export function App() {
  return window.location.hash === '#hrss-dashboard' ? <HrssDashboardWindowPage /> : <LicensedApp />;
}

function LicensedApp() {
  const [license, setLicense] = useState<LicenseStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await window.desktopApi.license.status() as LicenseStatus;
        if (!disposed) setLicense(current => JSON.stringify(current) === JSON.stringify(value) ? current : value);
      } catch { /* Keep the last known state on transient IPC failures; main-process checks still apply. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);

  if (!license) return <div className="splash">正在初始化安全运行环境…</div>;
  if (license.state !== 'active') return <ActivationPage status={license} onActivated={setLicense} />;
  return <Workspace license={license} />;
}

function ActivationPage({ status, onActivated }: { status: LicenseStatus; onActivated: (status: LicenseStatus) => void }) {
  const [mode, setMode] = useState<'online' | 'offline'>('online');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(status.message ?? '');

  const activate = async () => {
    setBusy(true);
    setMessage('正在验证授权…');
    try {
      const result = await window.desktopApi.license.activate(key) as LicenseStatus;
      onActivated(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '激活失败');
    } finally {
      setBusy(false);
    }
  };

  const importLicense = async () => {
    setBusy(true);
    setMessage('正在验证离线授权文件…');
    try {
      const result = await window.desktopApi.license.importFile() as LicenseStatus | null;
      if (result) onActivated(result);
      else setMessage('已取消导入');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '授权文件无效');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="activation-shell">
      <div className="activation-intro">
        <div className="activation-brand"><BrandMark /><div><strong>数据融合助手</strong><span>本地业务数据工作台</span></div></div>
        <h2>让数据回流，更简单</h2>
        <p>业务系统与实用工具，一处连接。</p>
        <div className="activation-features">
          <div><span><AppIcon name="components" size={25} /></span><div><strong>多系统协同</strong><p>保留原系统标签，随时切换核对。</p></div></div>
          <div><span><AppIcon name="database" size={25} /></span><div><strong>本机数据管理</strong><p>本地留存记录、版本与字段依据。</p></div></div>
          <div><span><AppIcon name="shield" size={25} /></span><div><strong>独立工具授权</strong><p>按需使用工具，无需登录业务系统。</p></div></div>
        </div>
      </div>
      <div className="activation-card">
        <span className="eyebrow">设备授权</span>
        <h1>{status.state === 'expired' ? '授权已经过期' : '激活数据融合助手'}</h1>
        <p>在线激活支持设备管理和自动更新；无法连接互联网的设备可以导入管理员签发的离线授权文件。</p>
        <div className="activation-tabs" role="group" aria-label="授权方式"><button aria-pressed={mode === 'online'} className={mode === 'online' ? 'active' : ''} onClick={() => setMode('online')}>在线激活</button><button aria-pressed={mode === 'offline'} className={mode === 'offline' ? 'active' : ''} onClick={() => setMode('offline')}>离线许可证</button></div>
        <label className="activation-field"><span>{mode === 'online' ? '在线激活码' : '离线授权密钥'}</span>{mode === 'online' ? <input value={key} onChange={event => setKey(event.target.value)} placeholder="请输入管理员分配的在线激活码" spellCheck={false} autoComplete="off" /> : <textarea value={key} onChange={(event) => setKey(event.target.value)} placeholder="粘贴 DFL1 开头的离线授权密钥，或导入授权文件" spellCheck={false} />}</label>
        <div className="device-id"><span>设备标识</span><code>{status.deviceId.slice(0, 12)}…{status.deviceId.slice(-8)}</code></div>
        <div className="activation-tools">{mode === 'offline' && <button className="text-button" onClick={importLicense} disabled={busy}>导入离线授权文件</button>}{import.meta.env.DEV && <button className="text-button" onClick={() => { setMode('offline'); setKey('DF-DEV-LOCAL'); }}>填入本机开发授权</button>}</div>
        {message && <div className="message activation-message">{message}</div>}
        <button className="primary activation-button" disabled={busy || !key.trim()} onClick={activate}>{busy ? '正在激活…' : '激活并进入工作台'}</button>
        <small>授权可分配业务系统或独立工具；只有访问原业务系统数据时，才需要登录相应系统。</small>
      </div>
    </div>
  );
}

function WorkspaceSidebar({ systems, matters, license, selectedSystemId, selectedMatterId, activePage, onNavigate, onMatterSelect }: {
  systems: SystemSummary[];
  matters: MatterSummary[];
  license: LicenseStatus;
  selectedSystemId: string;
  selectedMatterId: string;
  activePage: AppPage;
  onNavigate: (page: AppPage, systemId?: string) => void;
  onMatterSelect: (matter: MatterSummary) => void;
}) {
  const [expandedDepartments, setExpandedDepartments] = useState<Record<string, boolean>>({});
  const [expandedSystems, setExpandedSystems] = useState<Record<string, boolean>>({});
  const access = workspaceAccess(license);
  const hasDepartmentNavigation = matters.some((matter) => matter.departmentId);
  const departments = [...matters]
    .sort((left, right) => (left.departmentOrder ?? 999) - (right.departmentOrder ?? 999)
      || (left.matterOrder ?? 999) - (right.matterOrder ?? 999))
    .reduce<Array<{ id: string; name: string; matters: MatterSummary[] }>>((groups, matter) => {
      const id = matter.departmentId ?? 'ungrouped';
      const existing = groups.find((group) => group.id === id);
      if (existing) existing.matters.push(matter);
      else groups.push({ id, name: matter.departmentName ?? '其他', matters: [matter] });
      return groups;
    }, []);
  return <aside className="sidebar">
    <div className="brand"><BrandMark /><div><strong>数据融合助手</strong><span>本地业务工作台</span></div></div>
    <nav aria-label="主导航">
      {access.hasSystems && <><button className={`nav-item ${activePage === 'home' ? 'active' : ''}`} aria-current={activePage === 'home' ? 'page' : undefined} onClick={() => onNavigate('home')}><AppIcon name="home" /><span>工作台</span></button>
      <div className="nav-title">业务系统</div></>}
      {systems.map((system) => {
        const expanded = Boolean(expandedSystems[system.id]) && system.id === selectedSystemId && activePage === 'workspace';
        return <div key={system.id} className="system-nav-group">
          <button className={`nav-item system-nav-toggle ${system.id === selectedSystemId && activePage === 'workspace' ? 'active' : ''}`} aria-expanded={expanded} onClick={() => {
            setExpandedSystems((current) => ({ ...current, [system.id]: system.id !== selectedSystemId || !expanded }));
            onNavigate('workspace', system.id);
          }} title={system.name} aria-label={system.name}><AppIcon name={systemIcon(system.id)} /><span className="nav-label">{shortSystemName(system.id, system.name)}</span><AppIcon name="chevron" size={13} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} /></button>
          {expanded && system.id === selectedSystemId && activePage === 'workspace' && (hasDepartmentNavigation
            ? <div className="department-subnav">{departments.map((group) => {
              const key = `${system.id}/${group.id}`;
              const open = Boolean(expandedDepartments[key]);
              return <section className="department-nav-group" key={group.id}>
                <button className="department-nav-title" aria-expanded={open} onClick={() => setExpandedDepartments((current) => ({ ...current, [key]: !open }))}>
                  <span><AppIcon name="chevron" size={11} style={{ transform: open ? 'rotate(90deg)' : undefined }} />{group.name}</span><small>{group.matters.length}</small>
                </button>
                {open && <div className="matter-subnav">{group.matters.map((matter) => <button key={matter.id} title={matter.name} className={matter.id === selectedMatterId ? 'active' : ''} onClick={() => onMatterSelect(matter)}>{matter.name}</button>)}</div>}
              </section>;
            })}</div>
            : <div className="matter-subnav flat">{matters.map((matter) => <button key={matter.id} className={matter.id === selectedMatterId ? 'active' : ''} onClick={() => onMatterSelect(matter)}>{matter.name}</button>)}</div>)}
        </div>;
      })}
      {access.hasHealthTool && <><div className="nav-title">工具</div>
      <button className={`nav-item ${activePage === 'tools' ? 'active' : ''}`} aria-current={activePage === 'tools' ? 'page' : undefined} onClick={() => onNavigate('tools')}><AppIcon name="document" /><span>卫健局双公示工具</span></button></>}
      <div className="nav-title">平台管理</div>
      {access.canOpenPage('systems') && <button className={`nav-item ${activePage === 'systems' ? 'active' : ''}`} aria-current={activePage === 'systems' ? 'page' : undefined} onClick={() => onNavigate('systems')}><AppIcon name="components" /><span>组件管理</span></button>}
      <button className={`nav-item ${activePage === 'settings' ? 'active' : ''}`} aria-current={activePage === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><AppIcon name="settings" /><span>设置</span></button>
    </nav>
    <div className="local-note"><AppIcon name="shield" size={15} />业务数据仅保存在本机</div>
  </aside>;
}

function Workspace({ license }: { license: LicenseStatus }) {
  const access = workspaceAccess(license);
  const [defaultPageSize, setDefaultPageSize] = useState(DEFAULT_APP_SETTINGS.defaultPageSize);
  const scope = access.permissionKey;
  const [allSystems, setSystems] = useState<SystemSummary[]>([]);
  const [components, setComponents] = useState<ComponentSummary[]>([]);
  const [catalogScope, setCatalogScope] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRetry, setCatalogRetry] = useState(0);
  const sessionEvents = useRef(new Map<string, { revision: number; session: SessionState }>());
  const systems = useMemo(() => allSystems.filter(system => access.canOpenSystem(system.id)), [allSystems, scope]);
  const [requestedSystemId, setSelectedSystemId] = useState<string>('');
  const selectedSystemId = systems.some(system => system.id === requestedSystemId) ? requestedSystemId : systems[0]?.id ?? '';
  const [matters, setMatters] = useState<MatterSummary[]>([]);
  const [matterSystemId, setMatterSystemId] = useState('');
  const [selectedMatterId, setSelectedMatterId] = useState<string>('');
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const [queryResult, setQueryResult] = useState<QueryPage | null>(null);
  const rows = queryResult?.rows ?? [];
  const queryGeneration = useRef(0);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryMessage, setQueryMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [syncPreview, setSyncPreview] = useState<SyncPreview | null>(null);
  const [requestedPage, setActivePage] = useState<AppPage>(access.defaultPage);
  const activePage = access.resolvePage(requestedPage);
  useLayoutEffect(() => {
    setQueryResult(null); setSyncPreview(null); setQueryLoading(false); setQueryMessage('');
    return () => { queryGeneration.current++; };
  }, [activePage, selectedSystemId, selectedMatterId, scope, filters]);
  useEffect(() => {
    if (requestedPage !== activePage) setActivePage(activePage);
  }, [scope, requestedPage, activePage]);
  const [matterSection, setMatterSection] = useState<MatterSection>('return');
  const [selectedDataBatchId, setSelectedDataBatchId] = useState('');
  const [showPractitionerNumbers, setShowPractitionerNumbers] = useState(false);
  const numberMatters = selectedSystemId === 'transport-practitioner'
    ? PRACTITIONER_NUMBER_MATTERS.filter(id => access.canOpenMatter(selectedSystemId, id)) : [];
  const [showSystemCredentials, setShowSystemCredentials] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const updateState = useUpdateState();
  const [sourceTabs, setSourceTabs] = useState<SourceTabsState>({ tabs: [], activeSystemId: null });
  const [checkingLogin, setCheckingLogin] = useState(false);
  const pendingTaskNavigation = useRef<{ systemId: string; matterId: string; batchId: string } | null>(null);
  const [openingPublication, setOpeningPublication] = useState<PublicationPlatformId | null>(null);
  const visibleSourceTabs = sourceTabs.tabs.filter(tab => access.canOpenSourceTab(tab.systemId));
  const loginTab = visibleSourceTabs.find((tab) => tab.systemId === sourceTabs.activeSystemId);
  const publicationTab = publicationPlatform(loginTab?.systemId);
  const sourceSession = systems.find((system) => system.id === loginTab?.systemId)?.session;
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.desktopApi.systems.onTabsChanged(setSourceTabs);
    void window.desktopApi.systems.tabs().then(value => { if (!disposed) setSourceTabs(value); });
    return () => {
      disposed = true;
      unsubscribe();
      // A revoked/expired license unmounts the entire workspace. Its native
      // source view must be hidden too, without clearing the saved session.
      void window.desktopApi.systems.activateTab(null).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (sourceTabs.activeSystemId && !access.canOpenSourceTab(sourceTabs.activeSystemId)) {
      void window.desktopApi.systems.activateTab(null).then(setSourceTabs).catch(() => undefined);
    }
  }, [scope, sourceTabs.activeSystemId]);

  useEffect(() => window.desktopApi.systems.onSessionChanged((session) => {
    sessionEvents.current.set(session.systemId, { revision: (sessionEvents.current.get(session.systemId)?.revision ?? 0) + 1, session });
    setSystems((current) => current.map((system) => system.id === session.systemId ? { ...system, session } : system));
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        void navigateFromLogin('diagnostics');
      }
    };
    const reportError = (event: ErrorEvent) => {
      const detail = [event.message, event.filename && `${event.filename}:${event.lineno}:${event.colno}`].filter(Boolean).join(' · ');
      void window.desktopApi.diagnostics.report('error', 'renderer.error', detail).catch(() => undefined);
    };
    const reportRejection = (event: PromiseRejectionEvent) => {
      const detail = event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}\n${event.reason.stack ?? ''}` : String(event.reason);
      void window.desktopApi.diagnostics.report('error', 'renderer.rejection', detail).catch(() => undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('error', reportError);
    window.addEventListener('unhandledrejection', reportRejection);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('error', reportError);
      window.removeEventListener('unhandledrejection', reportRejection);
    };
  }, []);

  const selectedSystem = useMemo(
    () => systems.find((item) => item.id === selectedSystemId),
    [systems, selectedSystemId],
  );

  const selectedMatter = useMemo(
    () => matterSystemId === selectedSystemId && access.canOpenMatter(selectedSystemId, selectedMatterId) ? matters.find((item) => item.id === selectedMatterId) : undefined,
    [matters, selectedMatterId, matterSystemId, selectedSystemId, scope],
  );
  const primaryQueryKeys = new Set(['subjectName', 'uniscid', 'approveDate', 'applyno']);
  const compactQuery = (selectedMatter?.querySchema.length ?? 0) > 6;
  const advancedFieldCount = selectedMatter?.querySchema.filter(field => !primaryQueryKeys.has(field.key)).length ?? 0;
  const activeAdvancedCount = compactQuery ? selectedMatter!.querySchema.filter(field => !primaryQueryKeys.has(field.key) && hasDisplayValue(filters[field.key]) && (!Array.isArray(filters[field.key]) || (filters[field.key] as unknown[]).some(hasDisplayValue))).length : 0;

  useEffect(() => {
    let disposed = false;
    pendingTaskNavigation.current = null;
    setCatalogError('');
    const preferences = access.hasSystems ? window.desktopApi.settings.get().catch(() => undefined) : undefined;
    void Promise.all([window.desktopApi.components.list(), preferences]).then(([value, settings]) => {
      if (disposed) return;
      setDefaultPageSize(settings?.defaultPageSize ?? DEFAULT_APP_SETTINGS.defaultPageSize);
      const visible = value.filter(component => component.authorized && (component.kind === 'system'
        ? access.canOpenSystem(component.id) : access.canOpenTool(component.id)));
      const metadata: SystemSummary[] = visible.filter(component => component.kind === 'system').map(component => ({ ...component,
        session: sessionEvents.current.get(component.id)?.session ?? { systemId: component.id, status: 'unverified', message: '正在检测登录状态' } }));
      // Publish system and tool metadata together. Remote session validation never
      // delays discovery, and no hardcoded tool appears before this snapshot.
      setComponents(visible); setSystems(metadata); setCatalogScope(scope);
      if (!metadata.length) return;
      const revisions = new Map([...sessionEvents.current].map(([id, event]) => [id, event.revision]));
      void window.desktopApi.systems.list().then(value => {
        if (disposed) return;
        const sessions = new Map((value as SystemSummary[]).map(system => [system.id, system.session]));
        setSystems(current => current.map(system => {
          const event = sessionEvents.current.get(system.id);
          const session = event && event.revision !== revisions.get(system.id) ? event.session : sessions.get(system.id);
          return session ? { ...system, session } : system;
        }));
      }).catch(() => { if (!disposed) setMessage('部分系统的登录状态暂时无法检测，可以打开原系统核对。'); });
    }).catch(() => { if (!disposed) setCatalogError('组件暂时无法加载，请重试。'); });
    return () => { disposed = true; };
  }, [scope, catalogRetry]);

  useEffect(() => {
    if (!selectedSystemId) return;
    let disposed = false;
    setMatters([]);
    setSelectedMatterId('');
    setMessage('');
    window.desktopApi.matters.list(selectedSystemId).then((result) => {
      if (disposed) return;
      const list = (result as MatterSummary[]).filter(matter => access.canOpenMatter(selectedSystemId, matter.id));
      setMatters(list);
      setMatterSystemId(selectedSystemId);
      setSelectedMatterId(list[0]?.id ?? '');
      setFilters(list[0]?.defaultFilters ?? {});
      setMatterSection('return');
      setSelectedDataBatchId('');
      setShowSystemCredentials(false);
      setShowAdvancedFilters(false);
      const pending = pendingTaskNavigation.current;
      if (pending?.systemId === selectedSystemId) {
        const target = list.find(item => item.id === pending.matterId);
        if (target) {
          setSelectedMatterId(target.id); setFilters(target.defaultFilters ?? {});
          setSelectedDataBatchId(pending.batchId); setMatterSection('data');
        }
        pendingTaskNavigation.current = null;
      }
    }).catch((error: unknown) => {
      if (!disposed) setMessage(error instanceof Error ? error.message : '业务事项加载失败');
    });
    return () => { disposed = true; };
  }, [selectedSystemId, scope]);

  useEffect(() => {
    const sessionSystemId = loginTab?.systemId ?? selectedSystemId;
    if (!sessionSystemId || publicationPlatform(sessionSystemId)) return;
    let disposed = false;
    let refreshing = false;
    const refreshSession = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        // A focus event can arrive before the root has received a reduced
        // grant. Re-read local authorization before probing the old system.
        const currentLicense = await window.desktopApi.license.status() as LicenseStatus;
        if (disposed || !workspaceAccess(currentLicense).canOpenSystem(sessionSystemId)) return;
        const revision = sessionEvents.current.get(sessionSystemId)?.revision;
        const session = await window.desktopApi.systems.session(sessionSystemId) as SessionState;
        if (!disposed && revision === sessionEvents.current.get(sessionSystemId)?.revision) {
          setSystems((current) => current.map((system) => (
            system.id === sessionSystemId ? { ...system, session } : system
          )));
        }
      } catch {
        // Keep the last known state when the main process is restarting or temporarily unavailable.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => { void refreshSession(); }, 5_000);
    window.addEventListener('focus', refreshSession);
    void refreshSession();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshSession);
    };
  }, [selectedSystemId, loginTab?.systemId]);

  async function login(systemId = selectedSystemId) {
    if (!systemId || !access.canOpenSystem(systemId)) return;
    setLoading(true);
    setMessage('');
    try {
      setSourceTabs(await window.desktopApi.systems.login(systemId) as SourceTabsState);
    } catch (error) { setMessage(error instanceof Error ? error.message : '打开系统失败'); }
    finally { setLoading(false); }
  }

  async function activateSourceTab(systemId: string | null) {
    if (systemId && !access.canOpenSourceTab(systemId)) return;
    try { setSourceTabs(await window.desktopApi.systems.activateTab(systemId)); }
    catch (error) { setMessage(error instanceof Error ? error.message : '切换标签失败'); }
  }

  async function openPublication(platformId: PublicationPlatformId) {
    if (openingPublication || !access.canOpenSourceTab(platformId)) return;
    setOpeningPublication(platformId); setMessage('');
    try { setSourceTabs(await window.desktopApi.publications.open(platformId)); }
    catch (error) { setMessage(error instanceof Error ? error.message : '打开公示平台失败'); }
    finally { setOpeningPublication(null); }
  }

  async function closeSourceTab(systemId: string) {
    try { setSourceTabs(await window.desktopApi.systems.closeLogin(systemId) as SourceTabsState); }
    catch (error) { setMessage(error instanceof Error ? error.message : '关闭标签失败'); }
  }

  async function returnFromLogin() {
    if (checkingLogin) return;
    const id = loginTab?.systemId;
    if (!id) return;
    setCheckingLogin(true);
    try {
      const revision = sessionEvents.current.get(id)?.revision;
      const checked = await window.desktopApi.systems.session(id, true) as SessionState;
      const event = sessionEvents.current.get(id);
      const state = event && event.revision !== revision ? event.session : checked;
      setSystems((current) => current.map((system) => system.id === id ? { ...system, session: state } : system));
      await activateSourceTab(null);
      setMessage(state.status === 'authenticated' ? '已识别登录，原系统页面已保留，可随时切换核对' : state.message ?? '原系统页面已保留，请在标签页中完成登录');
    } catch (error) { setMessage(error instanceof Error ? error.message : '登录状态检测失败'); }
    finally { setCheckingLogin(false); }
  }

  async function navigateFromLogin(page: AppPage, systemId?: string) {
    if (!access.canOpenPage(page) || (systemId && !access.canOpenSystem(systemId))) return;
    await activateSourceTab(null);
    if (systemId) setSelectedSystemId(systemId);
    setActivePage(page);
  }

  async function runQueryAction<T>(pending: string, failure: string, action: () => Promise<T>, apply: (result: T) => void) {
    const generation = ++queryGeneration.current;
    setQueryLoading(true);
    setQueryMessage(pending);
    try {
      const result = await action();
      if (generation === queryGeneration.current) apply(result);
    } catch (error) {
      if (generation === queryGeneration.current) setQueryMessage(error instanceof Error ? error.message : failure);
    } finally {
      if (generation === queryGeneration.current) setQueryLoading(false);
    }
  }

  function query(targetPage = 1, pageSize = Math.min(defaultPageSize, 200)) {
    if (!selectedMatter || !access.canOpenMatter(selectedSystemId, selectedMatterId)) return;
    setQueryResult(null);
    setSyncPreview(null);
    void runQueryAction('正在查询…', '查询失败', () =>
      window.desktopApi.matters.query(selectedSystemId, selectedMatterId, { page: targetPage, pageSize, filters }),
    (result: QueryPage) => {
      setQueryResult(result);
      setQueryMessage(`共 ${result.total} 条，本页 ${result.rows.length} 条`);
    });
  }

  function runOneClickReturn() {
    if (!selectedMatter || !access.canOpenMatter(selectedSystemId, selectedMatterId)) return;
    setMessage('回流任务已创建，可在当前事项的回流任务中查看进度');
    setMatterSection('tasks');
    void window.desktopApi.matters.run(selectedSystemId, selectedMatterId, {
      page: 1,
      pageSize: 200,
      filters,
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : '数据回流失败');
    });
  }

  function selectMatter(matter: MatterSummary) {
    setSelectedMatterId(matter.id);
    setFilters(matter.defaultFilters ?? {});
    setMessage('');
    setMatterSection('return');
    setSelectedDataBatchId('');
    setShowAdvancedFilters(false);
  }

  function openTaskData(systemId: string, matterId: string, batchId: string) {
    if (!access.canOpenMatter(systemId, matterId)) return;
    const target = systemId === selectedSystemId ? matters.find(matter => matter.id === matterId) : undefined;
    if (target) {
      selectMatter(target); setSelectedDataBatchId(batchId); setMatterSection('data');
    } else {
      // The catalog may still be loading when a task is selected from the home page.
      pendingTaskNavigation.current = { systemId, matterId, batchId };
      setSelectedSystemId(systemId);
    }
    setActivePage('workspace');
  }

  function previewSync() {
    if (!selectedSystemId || !selectedMatterId || !queryResult?.rows.length) return;
    setSyncPreview(null);
    void runQueryAction('正在计算本页数据变化…', '同步预览失败', () =>
      window.desktopApi.sync.preview(selectedSystemId, selectedMatterId, rows), (result: SyncPreview) => {
      setSyncPreview(result);
      setQueryMessage(`第 ${queryResult.page} 页同步预览已生成，共 ${result.total} 条。`);
    });
  }

  function commitSync() {
    if (!queryResult || !syncPreview) return;
    void runQueryAction('正在写入本地数据库…', '写入失败', () => window.desktopApi.sync.commit(syncPreview.previewId), () => {
      setSyncPreview(null);
      setQueryMessage(`第 ${queryResult.page} 页数据已写入本地数据库。`);
    });
  }


  if (catalogScope !== scope) return <div className="component-bootstrap" aria-busy={!catalogError}>
    <BrandMark /><strong>数据融合助手</strong>
    {catalogError ? <><p role="alert">{catalogError}</p><button className="secondary" onClick={() => setCatalogRetry(value => value + 1)}>重新加载组件</button></>
      : <p role="status">正在加载已授权的系统与工具…</p>}
  </div>;

  return (
    <div className="app-shell">
      <WorkspaceSidebar systems={systems} matters={matterSystemId === selectedSystemId ? matters.filter(matter => access.canOpenMatter(selectedSystemId, matter.id)) : []} license={license} selectedSystemId={selectedSystemId} selectedMatterId={selectedMatterId} activePage={activePage} onNavigate={(page, id) => { void navigateFromLogin(page, id); }} onMatterSelect={(matter) => { void activateSourceTab(null); selectMatter(matter); }} />

      <section className="workspace-pane">
        <div className="browser-tabbar" role="tablist" aria-label="工作区和原系统">
          <button role="tab" aria-selected={!loginTab} className={`browser-tab ${!loginTab ? 'active' : ''}`} onClick={() => void activateSourceTab(null)}><span className="tab-home">融</span><span>{access.hasSystems ? '工作台' : access.hasHealthTool ? '工具' : '设置'}</span></button>
          {visibleSourceTabs.map((tab) => <div className={`source-tab ${tab.systemId === loginTab?.systemId ? 'active' : ''}`} key={tab.systemId}>
            <button role="tab" aria-selected={tab.systemId === loginTab?.systemId} title={tab.systemName} className="source-tab-select" onClick={() => void activateSourceTab(tab.systemId)}><i className={systems.find(system => system.id === tab.systemId)?.session.status === 'authenticated' ? 'source-session-dot online' : 'source-session-dot'} />{tab.loading ? '正在载入 · ' : ''}{shortSystemName(tab.systemId, tab.systemName)}</button>
            <button className="source-tab-close" aria-label={`关闭${tab.systemName}标签页`} onClick={() => void closeSourceTab(tab.systemId)}>×</button>
          </div>)}
        </div>
        {loginTab && <>
          <div className="browser-toolbar">
            <button className="browser-icon-button" title="后退" aria-label="后退" onClick={() => void window.desktopApi.systems.backLogin(loginTab.systemId)}>←</button>
            <button className="browser-icon-button" title="刷新" aria-label="刷新原系统" onClick={() => void window.desktopApi.systems.reloadLogin(loginTab.systemId)}><AppIcon name="refresh" size={18} /></button>
            <div className="browser-address" title={loginTab.error ?? loginTab.displayUrl}><span>{loginTab.error ?? loginTab.displayUrl}</span></div>
            {publicationTab ? <button className="detect-login-button" onClick={() => void activateSourceTab(null)}>返回回流数据</button> : <>
              <span className={`login-detection ${sourceSession?.status === 'authenticated' ? 'success' : ''}`} title={sourceSession?.message}><i />{sourceSession?.status === 'authenticated' ? '已识别登录' : sourceSession?.status === 'unverified' ? '会话待验证' : sourceSession?.status === 'expired' ? '登录已失效' : sourceSession?.status === 'logged-out' ? '未登录' : '待检测登录'}</span>
              <button className="detect-login-button" disabled={checkingLogin} onClick={() => void returnFromLogin()}>{checkingLogin ? '正在检测登录…' : '检测登录并返回工作台'}</button>
            </>}
          </div>
          <div className="browser-remote-stage"><div className="browser-loading">{loginTab.error ?? '正在显示原系统页面…'}</div></div>
        </>}
      <main className="content" hidden={Boolean(loginTab)}>
        <UpdateBanner state={updateState} onOpen={() => setActivePage('settings')} />
        {activePage === 'home' && message && <div className="message page-message" role="status">{message}</div>}
        {activePage === 'home' ? <HomePage systems={systems} license={license} loading={loading} onSelect={(id) => { setSelectedSystemId(id); setActivePage('workspace'); }} onLogin={(id) => { void login(id); }} onTool={() => setActivePage('tools')} onTask={openTaskData} /> : activePage === 'tools' ? <HealthPublicityPage licensed={Boolean(license.grant?.allowedTools?.includes('health-publicity'))} allowExport={Boolean(license.grant?.allowExport)} /> : activePage !== 'workspace' ? (
          <PlatformPage onPageSizeSaved={setDefaultPageSize} page={activePage} license={license} components={components} onNavigate={setActivePage} onSystemSelect={id => { if (access.canOpenSystem(id)) { setSelectedSystemId(id); setActivePage('workspace'); } }} />
        ) : <>
        <header className="topbar">
          <div>
            <h1>{selectedSystem?.name ?? '加载中…'}</h1>
            {selectedMatter && <p className="workspace-subtitle">{selectedMatter.departmentName ? `${selectedMatter.departmentName} / ` : ''}{selectedMatter.name}</p>}
          </div>
          <div className="session-box">
            {selectedSystem?.workspaceMode === 'list-ledger' && <button className="secondary" onClick={() => { void window.desktopApi.hrss.openDashboard().catch(error => setMessage(error instanceof Error ? error.message : '无法打开数据看板')); }}><AppIcon name="dashboard" size={18} />全屏数据看板</button>}
            <span className={`dot ${selectedSystem?.session.status === 'authenticated' ? 'online' : ''}`} />
            <span className={selectedSystem?.session.status === 'authenticated' ? 'session-verified' : ''} title={selectedSystem?.session.message}>{selectedSystem?.session.status === 'authenticated' ? '会话已验证' : sessionLabel(selectedSystem?.session)}</span>
            <button className="secondary" onClick={() => void login()} disabled={loading || !selectedSystemId}>
              {['authenticated', 'unverified'].includes(selectedSystem?.session.status ?? '') ? '打开原系统' : '登录系统'}
            </button>
            {numberMatters.length > 0 && <button className="secondary" onClick={() => setShowPractitionerNumbers(value => !value)}>编号配置</button>}
            {selectedSystem?.supportsCredentialConfiguration && <button className="secondary" onClick={() => setShowSystemCredentials((value) => !value)}>账号配置</button>}
          </div>
        </header>

        {showPractitionerNumbers && numberMatters.length > 0 && <PractitionerNumberPanel key={numberMatters.join('/')} allowedMatters={numberMatters} onClose={() => setShowPractitionerNumbers(false)} />}
        {showSystemCredentials && selectedSystem?.supportsCredentialConfiguration && <SystemCredentialPanel systemId={selectedSystemId} systemName={selectedSystem?.name ?? '当前业务系统'} onClose={() => setShowSystemCredentials(false)} onLogin={() => { setShowSystemCredentials(false); void login(); }} />}

        {['return-ledger', 'list-ledger'].includes(selectedSystem?.workspaceMode ?? '') && <nav className={`matter-workspace-tabs ${supportsGovernmentExport(selectedSystemId) ? 'government-workspace-tabs' : ''}`} aria-label="事项工作区">
          <button aria-pressed={matterSection === 'return'} className={matterSection === 'return' ? 'active' : ''} onClick={() => setMatterSection('return')}>数据回流</button>
          <button aria-pressed={matterSection === 'tasks'} className={matterSection === 'tasks' ? 'active' : ''} onClick={() => setMatterSection('tasks')}>回流任务</button>
          <button aria-pressed={matterSection === 'data'} className={matterSection === 'data' ? 'active' : ''} onClick={() => setMatterSection('data')}>回流数据</button>
        </nav>}
        {selectedMatter?.executionMode === 'one-click-return' && message && <div className="message page-message">{message}</div>}

        {!selectedMatter ? <div className="panel empty" role="status">{message || (matterSystemId === selectedSystemId ? '当前系统暂无可用业务事项。' : '正在加载业务事项…')}</div> : ['return-ledger', 'list-ledger'].includes(selectedSystem?.workspaceMode ?? '') && matterSection === 'tasks' ? <TaskCenterPage pageSize={defaultPageSize} key={`${selectedSystemId}/${selectedMatterId}`} systemId={selectedSystemId} matterId={selectedMatterId} matterName={selectedMatter?.name} onViewBatch={(batchId) => { setSelectedDataBatchId(batchId); setMatterSection('data'); }} /> : selectedSystem?.workspaceMode === 'list-ledger' && matterSection === 'data' ? <HrssLedgerPage defaultPageSize={defaultPageSize} key={selectedMatterId} matterId={selectedMatterId} matterName={selectedMatter.name} columns={selectedMatter.listColumns ?? []} batchId={selectedDataBatchId} onBatchChange={setSelectedDataBatchId} allowExport={license.grant?.allowExport} /> : selectedSystem?.workspaceMode === 'return-ledger' && matterSection === 'data' ? <LocalDataPage defaultPageSize={defaultPageSize} allowExport={Boolean(license.grant?.allowExport)} key={`${selectedSystemId}/${selectedMatterId}`} systemId={selectedSystemId} matterId={selectedMatterId} matterName={selectedMatter?.name} selectedBatchId={selectedDataBatchId} onBatchChange={setSelectedDataBatchId} onOpenPublication={openPublication} openingPublication={openingPublication} /> : <>

        {selectedMatter?.executionMode === 'one-click-return' ? (
          <>
          <section className="panel one-click-panel">
            <div className="one-click-copy">
              <h2 className="sr-only">{selectedMatter.name}</h2>
              <div className={`return-controls${selectedMatter.querySchema.some(field => field.type === 'select') ? ' return-controls-with-select' : ''}`}>
              <div className="return-date-fields">
                {selectedMatter.querySchema.filter((field) => field.type === 'date').map((field) => <label key={field.key}>
                  <span>{field.label}{field.required ? ' *' : ''}</span>
                  <input type="date" aria-describedby={selectedMatter.dateFilter ? 'hrss-date-condition-note' : undefined}
                    min={selectedMatter.dateFilter && field.key === 'endDate' ? String(filters.startDate ?? '') : undefined}
                    max={selectedMatter.dateFilter && field.key === 'startDate' ? String(filters.endDate ?? '') : undefined}
                    value={String(filters[field.key] ?? '')} onChange={(event) => setFilters((current) => ({ ...current, [field.key]: event.target.value }))} />
                </label>)}
              </div>
              <label className="return-matter-field"><span>业务事项</span><select value={selectedMatterId} onChange={event => { const matter = matters.find(item => item.id === event.target.value); if (matter) selectMatter(matter); }}>{matters.map(matter => <option key={matter.id} value={matter.id}>{matter.name}</option>)}</select></label>
              {selectedMatter.querySchema.filter(field => field.type === 'select').map(field => (
                <label className="return-matter-field" key={field.key}>
                  <span>{field.label}{field.required ? ' *' : ''}</span>
                  <select required={field.required} value={String(filters[field.key] ?? '')} onChange={event => {
                    const option = field.options?.find(item => String(item.value) === event.target.value);
                    setFilters(current => ({ ...current, [field.key]: option?.value ?? '' }));
                  }}>
                    <option value="">请选择</option>
                    {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              ))}
              </div>
              {selectedMatter.dateFilter && <HrssDateNotice condition={selectedMatter.dateFilter} />}
              <div className="one-click-flow" aria-label="回流处理流程"><span><b>1</b>自动提取</span><i>→</i><span><b>2</b>按事项规则筛选</span><i>→</i><span><b>3</b>去重保存</span><i>→</i><span><b>4</b>查看本次数据</span></div>
              <p className="return-scope-note">{selectedMatter.description}</p>
            </div>
            <div className="return-action-row">
            <button className="run-return-button" onClick={runOneClickReturn} disabled={loading || selectedSystem?.session.status !== 'authenticated'}>
              <strong>开始数据回流</strong>
            </button>
            <span>{selectedSystem?.session.status === 'authenticated' ? '提取完成后自动去重保存，可在回流任务中查看进度。' : selectedSystem?.session.status === 'unverified' ? '会话待验证，请检查网络。' : '请先在原系统标签页完成登录。'}</span>
            </div>
          </section>
          {selectedSystem?.workspaceMode === 'list-ledger' ? <HrssLedgerPage defaultPageSize={defaultPageSize} key={selectedMatterId} matterId={selectedMatterId} matterName={selectedMatter.name} columns={selectedMatter.listColumns ?? []} preview onViewAll={() => { setSelectedDataBatchId(''); setMatterSection('data'); }} /> : <ReturnPreview systemId={selectedSystemId} matterId={selectedMatterId} onViewAll={() => { setSelectedDataBatchId(''); setMatterSection('data'); }} />}
          </>
        ) : <>
        <section className="query-workspace">
          <div className="panel query-panel">
            <div className="panel-head">
              <div>
                <h3>{selectedMatter?.name ?? '查询条件'}</h3>
                <p>{selectedMatter?.description}</p>
              </div>
              {matters.length > 1 && <label className="query-matter-select"><span className="sr-only">业务事项</span><select value={selectedMatterId} onChange={event => { const matter = matters.find(item => item.id === event.target.value); if (matter) selectMatter(matter); }}>{matters.map(matter => <option key={matter.id} value={matter.id}>{matter.name}</option>)}</select></label>}
            </div>

            <div className="form-grid">
              {selectedMatter?.querySchema.filter(field => !compactQuery || showAdvancedFilters || primaryQueryKeys.has(field.key)).map((field) => (
                <label key={field.key}>
                  <span>{field.label}{field.required ? ' *' : ''}</span>
                  {field.type === 'select' ? (
                    <select
                      value={String(filters[field.key] ?? '')}
                      onChange={(event) => {
                        const selected = field.options?.find((option) => String(option.value) === event.target.value);
                        setFilters((old) => ({ ...old, [field.key]: selected?.value ?? '' }));
                      }}
                    >
                      {field.options?.map((option) => (
                        <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'multi-select' ? (
                    <select
                      multiple
                  value={
                    Array.isArray(filters[field.key])
                      ? (filters[field.key] as unknown[]).map(String)
                      : []
                  }
                      onChange={(event) => setFilters((old) => ({
                        ...old,
                        [field.key]: [...event.target.selectedOptions].map((option) =>
                          field.options?.find((item) => String(item.value) === option.value)?.value ?? option.value,
                        ),
                      }))}
                    >
                      {field.options?.map((option) => (
                        <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
                      ))}
                    </select>
                  ) : field.type === 'date-range' ? (
                    <div className="date-range">
                      <input
                        type="date"
                        aria-label={`${field.label}开始日期`}
                        value={String((filters[field.key] as unknown[] | undefined)?.[0] ?? '')}
                        onChange={(event) => setFilters((old) => ({
                          ...old,
                          [field.key]: [event.target.value, (old[field.key] as unknown[] | undefined)?.[1] ?? ''],
                        }))}
                      />
                      <span>至</span>
                      <input
                        type="date"
                        aria-label={`${field.label}结束日期`}
                        value={String((filters[field.key] as unknown[] | undefined)?.[1] ?? '')}
                        onChange={(event) => setFilters((old) => ({
                          ...old,
                          [field.key]: [(old[field.key] as unknown[] | undefined)?.[0] ?? '', event.target.value],
                        }))}
                      />
                    </div>
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                      placeholder={field.placeholder ?? `请输入${field.label}`}
                      value={String(filters[field.key] ?? '')}
                      onChange={(event) => setFilters((old) => ({
                        ...old,
                        [field.key]: field.type === 'number' && event.target.value !== ''
                          ? Number(event.target.value)
                          : event.target.value,
                      }))}
                    />
                  )}
                </label>
              ))}
            </div>

            <div className="actions">
              {compactQuery && <button className="text-button advanced-toggle" aria-expanded={showAdvancedFilters} onClick={() => setShowAdvancedFilters(value => !value)}>{showAdvancedFilters ? '收起更多条件' : `更多条件（${advancedFieldCount}）`}{activeAdvancedCount > 0 && ` · 已设置 ${activeAdvancedCount} 项`}</button>}
              <button className="secondary" onClick={() => setFilters({})}>清空条件</button>
              <button className="primary" onClick={() => query()} disabled={loading || queryLoading}>执行查询</button>
            </div>
            {(queryMessage || message) && <div className="message" role="status">{queryMessage || message}</div>}
          </div>
        </section>

        <section className="panel result-panel">
          <div className="panel-head">
            <div>
              <h3>查询结果预览</h3>
            </div>
            {rows.length > 0 && (
              <button className="primary" onClick={previewSync} disabled={queryLoading}>预览本页同步变化</button>
            )}
          </div>
          {syncPreview && (
            <div className="sync-preview">
              <div><span>总计</span><strong>{syncPreview.total}</strong></div>
              <div><span>新增</span><strong>{syncPreview.inserted}</strong></div>
              <div><span>更新</span><strong>{syncPreview.updated}</strong></div>
              <div><span>无变化</span><strong>{syncPreview.unchanged}</strong></div>
              <button className="primary" onClick={commitSync} disabled={queryLoading}>确认写入本页</button>
            </div>
          )}
          {rows.length === 0 ? (
            <div className="empty">{queryLoading ? '正在查询…' : '暂无查询结果'}</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>{Object.keys(rows[0]).map((key) => <th key={key}>{new Map<string, string>([...DOUBLE_PUBLICITY_TEMPLATE, ...(selectedMatter?.querySchema.map(field => [field.key, field.label] as const) ?? [])]).get(key) ?? key}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      {Object.keys(rows[0]).map((key) => <td key={key}>{String(row[key] ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {queryResult && queryResult.total > queryResult.pageSize && <Pagination page={queryResult.page} total={queryResult.total}
            pageCount={Math.ceil(queryResult.total / queryResult.pageSize)} onPage={page => query(page, queryResult.pageSize)} />}
        </section>
        </>}
        </>}
        </>}
      </main>
      </section>
    </div>
  );
}

function HomePage({ systems, license, loading, onSelect, onLogin, onTool, onTask }: {
  systems: SystemSummary[]; license: LicenseStatus; loading: boolean;
  onSelect: (id: string) => void; onLogin: (id: string) => void; onTool: () => void;
  onTask: (systemId: string, matterId: string, batchId: string) => void;
}) {
  const [tasks, setTasks] = useState<RuntimeTask[]>([]);
  const [message, setMessage] = useState('');
  const access = workspaceAccess(license);
  const systemIds = systems.map(system => system.id).join('|');
  useEffect(() => {
    let disposed = false;
    void window.desktopApi.tasks.list().then(value => {
      if (!disposed) setTasks((value as RuntimeTask[]).filter(task => task.systemId && (task.matterId ? access.canOpenMatter(task.systemId, task.matterId) : access.canOpenSystem(task.systemId))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5));
    }).catch(() => { if (!disposed) setMessage('近期任务暂时无法加载，可在各事项内查看。'); });
    return () => { disposed = true; };
  }, [systemIds, access.permissionKey]);
  const visibleTasks = tasks.filter(task => task.systemId && (task.matterId ? access.canOpenMatter(task.systemId, task.matterId) : access.canOpenSystem(task.systemId)));
  return <div className="home-page">
    <PageHeader eyebrow="" title="工作台" description="选择系统，开始今天的数据工作。" />
    <section aria-labelledby="home-systems-title"><div className="section-heading"><h2 id="home-systems-title">业务系统</h2><span>{systems.length} 个已授权系统</span></div>
      <div className="system-card-grid">{systems.map(system => <article className="system-card" key={system.id}>
        <SystemBadge id={system.id} />
        <div className="system-card-body"><div className="system-card-heading"><button className="system-card-title" title={system.name} onClick={() => onSelect(system.id)}>{shortSystemName(system.id, system.name)}</button><span className={`system-session-label ${system.session.status === 'authenticated' ? 'online' : ''}`} title={system.session.message}><i />{system.session.status === 'authenticated' ? '已登录' : system.session.status === 'unverified' ? '会话待验证' : system.session.status === 'logging-in' ? '正在登录' : '未登录'}</span></div><p title={system.description}>{systemDescription(system.id, system.description)}</p></div>
        <button className={system.session.status === 'authenticated' ? 'primary' : 'secondary'} disabled={loading} onClick={() => onLogin(system.id)}>{['authenticated', 'unverified'].includes(system.session.status) ? '打开原系统' : '登录系统'}</button>
      </article>)}</div>
      {!systems.length && <div className="panel empty">当前授权未包含业务系统，可以独立使用下方工具。</div>}
    </section>
    {access.hasHealthTool && <section className="home-tools" aria-labelledby="home-tools-title"><div className="section-heading"><h2 id="home-tools-title">常用工具</h2><span>无需登录原系统</span></div><article className="panel home-tool-card"><SystemBadge id="health-publicity" /><div><h3>卫健局双公示工具</h3><p>Word 文档生成双公示表格</p></div><button className="secondary" onClick={onTool}>打开工具</button></article></section>}
    <section className="panel home-recent"><div className="panel-head"><h3>最近回流任务</h3><span className="muted">最近 5 条 · 按系统查看完整记录</span></div>{message && <p role="status" className="message">{message}</p>}<div className="table-wrap"><table><thead><tr><th>事项任务</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleTasks.map(task => <tr key={task.id}><td>{task.name}</td><td>{new Date(task.createdAt).toLocaleString()}</td><td><span className={`status-chip ${task.status}`}>{taskStatusLabel(task.status)}</span></td><td>{task.status === 'completed' && task.type === 'data-return' && task.systemId && task.matterId ? <button className="link-button" onClick={() => onTask(task.systemId!, task.matterId!, task.id)}>查看数据</button> : task.systemId && <button className="link-button" onClick={() => onSelect(task.systemId!)}>进入系统</button>}</td></tr>)}{!visibleTasks.length && <tr><td colSpan={4} className="empty">暂无任务。进入业务系统后即可开始回流。</td></tr>}</tbody></table></div></section>
  </div>;
}

function ReturnPreview({ systemId, matterId, onViewAll }: { systemId: string; matterId: string; onViewAll: () => void }) {
  const [preview, setPreview] = useState<{ rows: LocalRecord[]; total: number }>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setPreview({ rows: [], total: 0 }); setLoading(true); setError('');
    if (!systemId || !matterId) { setLoading(false); return; }
    void window.desktopApi.records.list({ systemId, matterId, page: 1, pageSize: 10 }).then(value => {
      const result = value as { rows: LocalRecord[]; total: number };
      if (!disposed) setPreview({ rows: result.rows.slice(0, 5), total: result.total });
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : '本地预览暂时无法加载'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [systemId, matterId]);
  const issues = useMemo(() => new Map(validateExport(preview.rows).issues.map(issue => [issue.recordKey, issue])), [preview.rows]);
  return <section className="panel return-preview" aria-label="本地数据预览"><div className="panel-head"><div><h3>本地数据预览</h3><p>仅展示本机已保存的数据，不是原系统实时查询结果。</p></div><button className="text-button" onClick={onViewAll}>查看全部 {preview.total} 条 <AppIcon name="chevron" size={13} /></button></div>
    {error && <div className="message page-message" role="status">{error}</div>}<div className="table-wrap"><table><thead><tr><th>行政相对人名称</th><th>事项名称</th><th>决定日期</th><th>字段状态</th></tr></thead><tbody>{preview.rows.map((row, index) => { const issue = issues.get(row.recordKey); return <tr key={`${row.recordKey}-${index}`}><td>{String(row.data.xkXdrMc ?? row.data.applyer ?? '—')}</td><td>{String(row.data.xzxkmc ?? row.data.sxmc ?? '—')}</td><td>{String(row.data.xkJdrq || '—')}</td><td><span className={`status-chip ${issue ? 'warning' : 'ready'}`}>{issue ? `待核对 ${issue.fields.length} 项` : '无填写问题'}</span></td></tr>; })}{!preview.rows.length && <tr><td colSpan={4} className="empty">{loading ? '正在读取本地数据…' : '当前事项暂无本地数据，完成回流后可在此预览。'}</td></tr>}</tbody></table></div>{preview.total > 5 && <div className="preview-footnote">共 {preview.total} 条，预览最近 5 条。完整内容与字段依据请进入本地数据查看。</div>}
  </section>;
}

type RuntimeTask = {
  id: string; type: string; name: string; status: string; progress: { current: number; total?: number; message?: string };
  systemId?: string; matterId?: string; createdAt: number; finishedAt?: number; error?: string;
  details?: Record<string, unknown>;
};

type TaskOutputRow = {
  rowNo: number; systemId: string; matterId: string; recordKey: string; data: Record<string, unknown>;
};

function PlatformPage(props: {
  page: AppPage; license: LicenseStatus; components: ComponentSummary[]; onNavigate: (page: AppPage) => void; onSystemSelect: (id: string) => void;
  onPageSizeSaved: (size: number) => void;
}) {
  if (props.page === 'systems') return <ComponentCatalog components={props.components} license={props.license} onOpenTool={() => props.onNavigate('tools')} onOpenSystem={props.onSystemSelect} />;
  if (props.page === 'diagnostics') return <DiagnosticsPage onClose={() => props.onNavigate('settings')} />;
  return <SettingsPage license={props.license} onPageSizeSaved={props.onPageSizeSaved} onOpenDiagnostics={() => props.onNavigate('diagnostics')} />;
}

function PageHeader({ eyebrow, title, description, action, className = '' }: { eyebrow: string; title: string; description: string; action?: React.ReactNode; className?: string }) {
  return <header className={`page-header ${className}`}><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>{action}</header>;
}

function TaskCenterPage({ systemId, matterId, matterName, pageSize, onViewBatch }: { pageSize: number; systemId: string; matterId: string; matterName?: string; onViewBatch: (batchId: string) => void }) {
  const [tasks, setTasks] = useState<RuntimeTask[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let timer: number;
    const refresh = async () => {
      try {
        const result = await window.desktopApi.tasks.page({ systemId, matterId, page, pageSize });
        if (disposed) return;
        setTasks(result.rows); setTotal(result.total); setError('');
        setPage(Math.min(page, Math.max(1, Math.ceil(result.total / pageSize))));
      } catch {
        if (!disposed) { setTasks([]); setError('任务列表暂时无法加载，请稍后重试。'); }
      } finally {
        if (!disposed) { setLoading(false); timer = window.setTimeout(() => void refresh(), 3_000); }
      }
    };
    setLoading(true); setTasks([]);
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [systemId, matterId, page, pageSize, revision]);
  const cancel = async (id: string) => {
    try { await window.desktopApi.tasks.cancel(id); setRevision(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : '取消失败'); }
  };
  const taskPeriod = (task: RuntimeTask) => {
    if (systemId === 'guangdong-hrss') return hrssTaskDateLabel(task.details);
    const start = typeof task.details?.startDate === 'string' ? task.details.startDate : '';
    const end = typeof task.details?.endDate === 'string' ? task.details.endDate : '';
    return start || end ? `${start || '—'} 至 ${end || '—'}` : '—';
  };
  return <>
    <PageHeader eyebrow="事项工作区 / 任务" title={`${matterName ?? '当前事项'} · 回流任务`} description="查看当前事项的处理进度、结果与批次数据。" />
    {error && <div className="inline-error" role="status">{error}</div>}
    <section className="panel data-panel task-table-panel"><table><thead><tr><th>批次号</th><th>任务</th><th>回流时间段</th><th>状态</th><th>进度</th><th>生成时间</th><th>结果</th><th></th></tr></thead><tbody>
      {tasks.map((task) => { const percent = taskProgressPercent(task.progress, task.status); return <tr key={task.id}><td className="batch-id" title={task.id}>{task.id.slice(0, 8).toUpperCase()}</td><td>{task.name}</td><td>{taskPeriod(task)}</td><td><span className={`status-chip ${task.status}`}>{taskStatusLabel(task.status)}</span></td><td><div className="task-progress">{percent !== undefined && <progress max={100} value={percent} aria-label={`${task.name}进度`} />}<span>{task.progress.message ?? (percent !== undefined ? `${percent}%` : '等待进度')}</span></div></td><td>{new Date(task.createdAt).toLocaleString()}</td><td className={task.error ? 'error-text' : ''}>{task.error ?? (task.finishedAt ? taskStatusLabel(task.status) : '执行中')}</td><td>{['queued', 'running'].includes(task.status) && <button className="link-button error-text" onClick={() => void cancel(task.id)}>取消</button>}{task.type === 'data-return' && task.status === 'completed' && <button className="link-button" onClick={() => onViewBatch(task.id)}>在回流数据中查看</button>}</td></tr>; })}
      {!tasks.length && <tr><td colSpan={8} className="empty">{loading ? '正在读取任务…' : error ? '暂时无法读取任务' : '暂无任务记录'}</td></tr>}
    </tbody></table></section>
    {total > pageSize && <Pagination page={page} pageCount={Math.ceil(total / pageSize)} total={total} onPage={setPage} />}
  </>;
}

type LocalRecord = { systemId: string; matterId: string; recordKey: string; data: Record<string, unknown>; firstSeenAt?: number; updatedAt?: number; rowNo?: number };

function Pagination({ page, pageCount, total, onPage, pageSize, defaultPageSize = DEFAULT_APP_SETTINGS.defaultPageSize, onPageSize }: { defaultPageSize?: number; page: number; pageCount: number; total: number; onPage: (page: number) => void; pageSize?: number; onPageSize?: (size: number) => void }) {
  return <div className="pagination"><span>共 {total} 条 · 第 {page}/{pageCount} 页</span>{onPageSize && <label>每页<select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}><PageSizeOptions defaultPageSize={defaultPageSize} /></select>条</label>}<button className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button><button className="secondary" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>下一页</button></div>;
}

function LocalDataPage({ systemId, matterId, matterName, selectedBatchId, onBatchChange, onOpenPublication, openingPublication, defaultPageSize, allowExport }: { defaultPageSize: number; allowExport: boolean; systemId: string; matterId: string; matterName?: string; selectedBatchId: string; onBatchChange: (batchId: string) => void; onOpenPublication: (id: PublicationPlatformId) => Promise<void>; openingPublication: PublicationPlatformId | null }) {
  const [keyword, setKeyword] = useState('');
  const batchPages = useCompletedBatches(systemId, matterId, selectedBatchId);
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const { batches } = batchPages;
  const selectedBatch = batches.find(task => task.id === selectedBatchId);
  const [rows, setRows] = useState<LocalRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [selected, setSelected] = useState<LocalRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftData, setDraftData] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [showEmptyFields, setShowEmptyFields] = useState(false);
  const [drawerMessage, setDrawerMessage] = useState('');
  const [versions, setVersions] = useState<Array<{ version: number; capturedAt: number; data: Record<string, unknown> }>>([]);
  const [message, setMessage] = useState('');
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingTarget, setExportingTarget] = useState<GovernmentExportTarget>();
  const exportInFlight = useRef(false);
  const exportGeneration = useRef(0);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const [loadingRows, setLoadingRows] = useState(true);
  const [listError, setListError] = useState('');
  useLayoutEffect(() => {
    exportGeneration.current += 1;
    setExportResult(null); setMessage(''); setSelected(null); setSaving(false); setPage(1);
    return () => { exportGeneration.current++; listGeneration.current++; detailGeneration.current++; };
  }, [systemId, matterId, selectedBatchId]);
  const rowIssues = useMemo(() => new Map(validateExport(rows).issues.map(issue => [issue.recordKey, issue])), [rows]);
  const load = async (targetPage = page, targetPageSize = pageSize, filter = appliedKeyword) => {
    const generation = ++listGeneration.current;
    exportGeneration.current++;
    setExportResult(null);
    setRows([]); setTotal(0); setLoadingRows(true); setListError('');
    try {
      const search = filter || undefined;
      if (selectedBatchId) {
        const result = await window.desktopApi.tasks.output(selectedBatchId, targetPage, targetPageSize, search) as { rows: TaskOutputRow[]; total: number };
        if (generation !== listGeneration.current) return;
        setRows(result.rows);
        setTotal(result.total);
      } else {
        const result = await window.desktopApi.records.list({ keyword: search, systemId, matterId, page: targetPage, pageSize: targetPageSize }) as { rows: LocalRecord[]; total: number };
        if (generation !== listGeneration.current) return;
        setRows(result.rows); setTotal(result.total);
      }
      setAppliedKeyword(filter); setPage(targetPage); setPageSize(targetPageSize);
    } catch (error) {
      if (generation === listGeneration.current) setListError(error instanceof Error ? error.message : '读取回流数据失败，请重新查询');
    } finally {
      if (generation === listGeneration.current) setLoadingRows(false);
    }
  };
  useEffect(() => {
    setKeyword(''); setPage(1); setSelected(null);
  }, [systemId, matterId]);
  useLayoutEffect(() => { void load(1, pageSize); }, [systemId, matterId, selectedBatchId]);
  const exportDisabled = exporting || loadingRows || !total || Boolean(listError);
  const exportData = async (target?: GovernmentExportTarget) => {
    if (!allowExport || exportDisabled || exportInFlight.current) return;
    const generation = exportGeneration.current;
    exportInFlight.current = true; setExporting(true); setExportingTarget(target); setMessage(''); setExportResult(null);
    try {
      const result = selectedBatchId
        ? await window.desktopApi.tasks.exportOutput(selectedBatchId, appliedKeyword || undefined, target) as ExportResult | null
        : await window.desktopApi.records.export({ keyword: appliedKeyword || undefined, systemId, matterId }, 'xlsx', target) as ExportResult | null;
      if (generation === exportGeneration.current) {
        setExportResult(result);
        if (!result) setMessage('已取消导出');
      }
    } catch (error) { if (generation === exportGeneration.current) setMessage(error instanceof Error ? error.message : '导出失败'); }
    finally { exportInFlight.current = false; setExporting(false); setExportingTarget(undefined); }
  };
  const openRecord = async (row: LocalRecord) => {
    const generation = ++detailGeneration.current;
    setSelected(row); setDraftData({ ...row.data }); setEditing(false); setShowEmptyFields(false); setDrawerMessage('');
    setVersions([]);
    if (selectedBatchId) return;
    try {
      const history = await window.desktopApi.records.versions(row.systemId, row.matterId, row.recordKey) as typeof versions;
      if (generation === detailGeneration.current) setVersions(history);
    } catch (error) {
      if (generation === detailGeneration.current) setDrawerMessage(error instanceof Error ? error.message : '历史版本读取失败');
    }
  };
  const saveRecord = async () => {
    if (!selected || selectedBatchId || saving) return;
    const generation = ++detailGeneration.current;
    setSaving(true); setMessage(''); setDrawerMessage('');
    try {
      const updated = await window.desktopApi.records.update(selected.systemId, selected.matterId, selected.recordKey, draftData) as LocalRecord;
      if (generation !== detailGeneration.current) return;
      setSelected(updated); setDraftData({ ...updated.data }); setEditing(false);
      setMessage('数据已修改并保存，历史版本已自动留存。');
      void load(page, pageSize);
      const history = await window.desktopApi.records.versions(updated.systemId, updated.matterId, updated.recordKey) as typeof versions;
      if (generation === detailGeneration.current) setVersions(history);
    } catch (error) { if (generation === detailGeneration.current) setDrawerMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { if (generation === detailGeneration.current) setSaving(false); }
  };
  const closeRecord = () => {
    if (saving) return;
    if (editing && selected && JSON.stringify(draftData) !== JSON.stringify(selected.data) && !window.confirm('字段有未保存的修改，确定放弃本次修改？')) return;
    detailGeneration.current++;
    setSelected(null);
  };
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rawGovernment = systemId === 'government-info' && rows.some((row) => !('xzxkmc' in row.data));
  const isEquipmentRegistration = systemId === EQUIPMENT_SYSTEM_ID && matterId === USE_REGISTRATION.id;
  const provincialFields = [
    ['ajmc', isEquipmentRegistration ? '案件名称（含省执法许可内容）' : '案件名称'],
    ['xkCljg', '省执法处理结果'], ['xkZqly', '职权来源'],
    ...(isEquipmentRegistration ? [['provincialDocumentNumber', '省执法决定书文号'] as const] : []),
  ] as const;
  const columns: ReadonlyArray<readonly [string, string]> = rawGovernment ? [
    ['cityLsh', '市流水号'], ['sblsh', '申办流水号'], ['sxmc', '业务事项'],
    ['applyer', '申请人/单位'], ['cardNumber', '证件号码'], ['receiveType', '收件方式'],
    ['applyDate', '申请日期'], ['creater', '创建人'], ['processResult', '处理结果'],
    ['area', '区域'], ['department', '部门'], ['currentLink', '当前环节'],
    ['approveDate', '办结日期'], ['fdApproveDate', '法定办结时间'],
    ...CERTIFICATE_FIELDS.map(({ key, label }) => [key, label] as const),
    ...provincialFields,
  ] : supportsGovernmentExport(systemId) ? [...DOUBLE_PUBLICITY_TEMPLATE, ...provincialFields] : DOUBLE_PUBLICITY_TEMPLATE;
  const visibleListKeys: readonly string[] = rawGovernment
    ? ['cityLsh', 'sxmc', 'applyer', 'cardNumber', 'approveDate', 'certificateNumber']
    : RECORD_LIST_COLUMN_KEYS;
  const listColumns = columns.filter(([key]) => visibleListKeys.includes(key) && rows.some((row) => hasDisplayValue(row.data[key])));
  const detailColumns = columns.filter(([key]) => showEmptyFields || hasDisplayValue((editing ? draftData : selected?.data ?? {})[key]));
  const hiddenFieldCount = columns.length - detailColumns.length;
  const selectedTitle = String(selected?.data.xkXdrMc ?? selected?.data.applyer ?? selected?.data.xzxkmc ?? '数据详情');
  const selectedDocumentNo = String(selected?.data.xkWsh ?? selected?.data.xkXkbh ?? selected?.data.certificateNumber ?? selected?.data.cityLsh ?? '').trim();
  const batchLabel = (task: RuntimeTask) => {
    const start = typeof task.details?.startDate === 'string' ? task.details.startDate : '—';
    const end = typeof task.details?.endDate === 'string' ? task.details.endDate : '—';
    return `${task.id.slice(0, 8).toUpperCase()} · ${start} 至 ${end} · ${new Date(task.createdAt).toLocaleString()}`;
  };
  return <>
    <PageHeader className={supportsGovernmentExport(systemId) ? 'publication-page-header' : ''} eyebrow="事项工作区 / 本地数据" title={`${matterName ?? '当前事项'} · 回流数据`} description={selectedBatchId ? `当前查看批次 ${selectedBatchId.slice(0, 8).toUpperCase()}，共 ${total} 条回流记录。` : `当前查看合并台账，共 ${total} 条回流记录。`} action={<div className="button-row publication-actions">
      {allowExport && (supportsGovernmentExport(systemId) ? (['guangdong-law', 'nanshan'] as const).map((target, index) => <button key={target} className={index === 0 ? 'primary' : 'secondary'} disabled={exportDisabled} aria-busy={exporting && exportingTarget === target} title={`${selectedBatchId ? '导出当前批次' : '导出当前筛选台账'}，使用${GOVERNMENT_EXPORT_LABELS[target]}模板`} onClick={() => void exportData(target)}><AppIcon name="download" size={16} />{exporting && exportingTarget === target ? '导出中…' : `导出${GOVERNMENT_EXPORT_LABELS[target]}`}</button>) : <button className="primary" disabled={exportDisabled} aria-busy={exporting} onClick={() => void exportData()}><AppIcon name="download" size={16} />{exporting ? '导出中…' : `导出数据${selectedBatchId ? '当前批次' : ''}`}</button>)}
      {publicationPlatformsForSystem(systemId).map(platform => <button className="secondary" key={platform.id} disabled={Boolean(openingPublication)} aria-busy={openingPublication === platform.id} title={`打开${platform.name}，登录后保留页面`} onClick={() => void onOpenPublication(platform.id)}><AppIcon name="upload" size={16} />{openingPublication === platform.id ? '正在打开…' : platform.buttonLabel}</button>)}
    </div>} />
    {message && <div className="message page-message" role="status">{message}</div>}
    {batchPages.error && <div className="inline-error" role="status">{batchPages.error}</div>}
    {allowExport && exportResult && <ExportNotice result={exportResult} />}
    <section className="panel filter-bar batch-filter-bar"><label><span>回流批次</span><select value={selectedBatchId} onChange={(event) => selectBatchOption(event.target.value, batchPages, onBatchChange)}><option value="">当前合并台账（可修改）</option>{batches.map((task) => <option value={task.id} key={task.id}>{batchLabel(task)}</option>)}<BatchPageOptions {...batchPages} /></select></label><label><span>数据搜索</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void load(1, pageSize, keyword.trim()); }} placeholder="搜索行政相对人、证件号码或许可项目"/></label><button className="primary" onClick={() => void load(1, pageSize, keyword.trim())}>查询</button></section>
    <section className="panel data-panel record-table-panel" aria-busy={loadingRows}><table><thead><tr><th>序号</th>{listColumns.map(([key, label]) => <th key={key}>{label}</th>)}<th>字段状态</th><th>{selectedBatchId ? '批次完成时间' : '更新时间'}</th><th>操作</th></tr></thead><tbody>{rows.map((row, index) => { const issue = rowIssues.get(row.recordKey); const timestamp = selectedBatchId ? selectedBatch?.finishedAt ?? selectedBatch?.createdAt : row.updatedAt; return <tr className={issue ? 'record-row-warning' : ''} key={`${row.systemId}-${row.matterId}-${row.recordKey}-${row.rowNo ?? index}`}><td>{row.rowNo ?? ((page - 1) * pageSize + index + 1)}</td>{listColumns.map(([key]) => { const value = String(row.data[key] ?? '').trim(); return <td key={key} className={`record-cell record-cell-${key}`}><span className="cell-ellipsis" title={value}>{value || '—'}</span></td>; })}<td><span className={`status-chip ${issue ? 'warning' : 'ready'}`} title={issue?.fields.map(field => `${field.label}：${field.message}`).join('\n')}>{issue ? `待核对 ${issue.fields.length} 项` : '无填写问题'}</span></td><td className="record-time-cell">{timestamp == null ? '—' : new Date(timestamp).toLocaleString()}</td><td><button className="link-button" onClick={() => void openRecord(row)}>{selectedBatchId ? '查看快照' : '查看修改'}</button></td></tr>; })}{!rows.length && <tr><td colSpan={listColumns.length + 4} className="empty">{loadingRows ? '正在读取回流数据…' : listError || '当前查询条件暂无回流数据'}</td></tr>}</tbody></table></section>
    <Pagination page={page} pageCount={pageCount} total={total} pageSize={pageSize} defaultPageSize={defaultPageSize} onPage={(target) => void load(target, pageSize)} onPageSize={(size) => void load(1, size)} />
    {selected && <Modal backdropClassName="drawer-backdrop" className="record-drawer" labelledBy="record-detail-title" onClose={closeRecord}>
      <div className="drawer-head"><div className="drawer-title"><span className="eyebrow">{selectedBatchId ? '批次快照' : '记录详情'}</span><h2 id="record-detail-title">{selectedTitle}</h2><p>{selectedDocumentNo || '未填写许可文书号'}</p></div><div className="drawer-actions">{!selectedBatchId && (editing ? <><button className="secondary" disabled={saving} onClick={() => { setDraftData({ ...selected.data }); setEditing(false); setDrawerMessage(''); }}>取消</button><button className="primary" disabled={saving} onClick={() => void saveRecord()}>{saving ? '保存中…' : '保存修改'}</button></> : <button className="primary" onClick={() => { setEditing(true); setDrawerMessage(''); }}>修改数据</button>)}<button className="secondary" disabled={saving} onClick={closeRecord}>关闭</button></div></div>
      {drawerMessage && <div className="inline-error drawer-message">{drawerMessage}</div>}
      {selectedBatchId && <div className="snapshot-notice">当前是历史批次快照，不允许修改。如需修改，请在上方“回流批次”切换到“当前合并台账”。</div>}
      <div className="drawer-section-head"><h3 className="drawer-section-title">{editing ? '编辑当前数据' : selectedBatchId ? '批次快照数据' : '当前数据'}</h3><button className="link-button" onClick={() => setShowEmptyFields((value) => !value)}>{showEmptyFields ? '隐藏空字段' : `显示空字段（${hiddenFieldCount}）`}</button></div>
      {editing ? <div className="record-edit-form">{detailColumns.map(([key, label]) => { const value = String(draftData[key] ?? ''); const longField = key === 'xkNr' || key === 'bz' || value.length > 80; return <label key={key} className={longField ? 'wide-field' : ''}><span>{label}</span>{longField ? <textarea value={value} onChange={(event) => setDraftData({ ...draftData, [key]: event.target.value })} /> : <input value={value} onChange={(event) => setDraftData({ ...draftData, [key]: event.target.value })} />}</label>; })}</div> : <div className="detail-list">{detailColumns.map(([key, label]) => <div key={key}><span>{label}</span><strong>{String(selected.data[key] ?? '')}</strong></div>)}</div>}
      {systemId === 'government-info' && <GovernmentCertificateEvidence data={selected.data} editing={editing} />}
      {systemId === 'oversize-transport' && <OversizeApplicationEvidence data={selected.data} />}
      {!selectedBatchId && !editing && <><h3 className="drawer-section-title">历史版本</h3><div className="version-timeline">{versions.map((version) => <div key={`${version.version}-${version.capturedAt}`}><i /><div><strong>版本 {version.version}</strong><span>{new Date(version.capturedAt).toLocaleString()} · {Object.keys(version.data).length} 个字段</span></div></div>)}{!versions.length && <p className="muted">暂无历史版本</p>}</div></>}
    </Modal>}
  </>;
}

function SystemCredentialPanel({ systemId, systemName, onClose, onLogin }: { systemId: string; systemName: string; onClose: () => void; onLogin: () => void }) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [configured, setConfigured] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void window.desktopApi.credentials.status(systemId).then((value) => {
      const status = value as { configured: boolean; account: string };
      setConfigured(status.configured); setAccount(status.account);
    }).catch((error) => setMessage(error instanceof Error ? error.message : '读取账号配置失败'));
  }, [systemId]);
  const save = async () => {
    setMessage('');
    try {
      const result = await window.desktopApi.credentials.save(systemId, account, password) as { configured: boolean; account: string };
      setConfigured(result.configured); setAccount(result.account); setPassword('');
      onLogin();
    } catch (error) { setMessage(error instanceof Error ? error.message : '账号密码保存失败'); }
  };
  return <section className="panel credential-card system-credential-card"><div className="panel-head"><div><span className="eyebrow">当前系统 / 账号</span><h3>{systemName} · 系统账号配置</h3></div><div className="drawer-actions"><span className={`status-chip ${configured ? 'ready' : 'disabled'}`}>{configured ? '已配置' : '未配置'}</span><button className="secondary" onClick={onClose}>收起</button></div></div><p>这是当前业务系统自己的账号配置，仅供该系统内部事项共用，不会应用到其他业务系统。</p><div className="credential-form"><label><span>系统账号</span><input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" placeholder="请输入系统账号" /></label><label><span>系统密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder={configured ? '输入新密码可更新配置' : '请输入系统密码'} /></label><button className="primary" disabled={!account.trim() || !password} onClick={() => void save()}>{configured ? '更新并打开登录页' : '保存并打开登录页'}</button></div>{message && <div className="message page-message">{message}</div>}</section>;
}

function SettingsPage({ license, onOpenDiagnostics, onPageSizeSaved }: { license: LicenseStatus; onOpenDiagnostics: () => void; onPageSizeSaved: (size: number) => void }) {
  const access = workspaceAccess(license);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [audit, setAudit] = useState<Array<{ id: string; type: string; createdAt: number; systemId?: string }>>([]);
  const [message, setMessage] = useState('');
  const [updateMessage, setUpdateMessage] = useState('');
  const updateState = useUpdateState();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  useEffect(() => { setUpdateMessage(''); }, [updateState?.status, updateState?.version, updateState?.checkedAt]);
  const [diagnosticClicks, setDiagnosticClicks] = useState(0);
  useEffect(() => { void Promise.all([window.desktopApi.settings.get(), window.desktopApi.audit.list()]).then(([s, a]) => { setSettings(s); setAudit(a as typeof audit); }).catch(() => setMessage('读取设置失败，请重新打开设置页面')); }, []);
  const save = async () => {
    if (!settings) return;
    try {
      const saved = await window.desktopApi.settings.update({
        ...(access.hasSystems ? { defaultPageSize: settings.defaultPageSize, taskConcurrency: settings.taskConcurrency } : {}),
        ...(updateState?.kind === 'business' ? {} : { autoCheckUpdates: settings.autoCheckUpdates }),
      });
      setSettings(saved); onPageSizeSaved(saved.defaultPageSize); setMessage('设置已保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
  };
  const checkUpdates = async () => {
    setUpdateMessage('正在校验更新清单…');
    setCheckingUpdate(true);
    try {
      const result = await window.desktopApi.updates.check() as { configured: boolean; app?: { version: string }; businessVersion?: string; message?: string };
      if (!result.configured) setUpdateMessage(result.message ?? '未配置更新服务');
      else if (result.businessVersion) setUpdateMessage(result.message ?? '业务更新检查已完成');
      else if (!result.app) setUpdateMessage('当前已是最新版本');
      else setUpdateMessage('');
    } catch (error) { setUpdateMessage(error instanceof Error ? error.message : '更新检查失败'); }
    finally { setCheckingUpdate(false); }
  };
  const installUpdate = async () => {
    if (updateState?.status !== 'ready') return;
    const systemInstaller = updateState.installMode === 'system';
    const businessUpdate = updateState.installMode === 'startup';
    if (!window.confirm(businessUpdate
      ? `确定重新启动并应用业务版本 ${updateState.version} 吗？应用将保存登录会话和业务数据，随后重新启动进入新版本。`
      : systemInstaller
      ? `确定打开系统安装器安装 ${updateState.version} 吗？请先保存正在编辑的数据。应用会保存登录会话并退出，保留授权和业务记录；请按系统提示完成安装后重新打开应用。`
      : `确定重启并更新至 ${updateState.version} 吗？请先保存正在编辑的数据。应用会保存登录会话，保留授权和业务记录；正在运行的业务任务不会被强制终止。`)) return;
    setUpdateMessage(systemInstaller ? '正在保存会话，准备打开系统安装器…' : '正在保存会话，准备重启更新…');
    try {
      await window.desktopApi.updates.install();
      setUpdateMessage(systemInstaller ? '请在系统安装器中确认安装，完成后重新打开应用' : '应用退出后自动安装，完成后重新打开');
    } catch (error) { setUpdateMessage(error instanceof Error ? error.message : '更新安装失败'); }
  };
  return <>
    <PageHeader eyebrow="" title="设置" description="调整使用偏好，检查应用更新。" />
    {message && <div className="message page-message" role="status">{message}</div>}
    <div className="settings-grid">
      <section className="panel settings-card runtime-settings"><h3>使用偏好</h3>{settings && <div className="settings-form">{access.hasSystems && <><label><span>默认每页数量</span><input type="number" min={10} max={500} step={1} value={settings.defaultPageSize} onChange={(e) => setSettings({ ...settings, defaultPageSize: Number(e.target.value) })}/></label><label><span>任务并发数</span><input type="number" min={1} max={10} step={1} value={settings.taskConcurrency} onChange={(e) => setSettings({ ...settings, taskConcurrency: Number(e.target.value) })}/></label></>}{updateState?.kind === 'business' ? <p className="muted">启动时检查业务更新；确认存在新版本后，更新完成才能进入应用。无法联网且尚未确认新版时，可使用已校验的本地版本。</p> : <label className="check-row"><input type="checkbox" checked={Boolean(settings.autoCheckUpdates)} onChange={(e) => setSettings({ ...settings, autoCheckUpdates: e.target.checked })}/><span>自动检查并下载更新</span></label>}<button className="primary" onClick={save}>保存设置</button></div>}</section>
      <UpdateStatus state={updateState} checking={checkingUpdate} message={updateMessage} onCheck={() => void checkUpdates()} onInstall={() => void installUpdate()} />
    </div>
    <section className="panel audit-card"><div className="panel-head"><h3>最近操作记录</h3><span className="muted">仅保存在本机</span></div><div className="audit-list">{audit.filter(event => !event.systemId || access.canOpenSystem(event.systemId)).slice(0, 20).map((event) => <div key={event.id}><span>{event.type}</span><strong>{event.systemId ? shortSystemName(event.systemId) : '平台'}</strong><time>{new Date(event.createdAt).toLocaleString()}</time></div>)}{!audit.some(event => !event.systemId || access.canOpenSystem(event.systemId)) && <div className="empty">暂无操作记录</div>}</div></section>
    <button className="diagnostics-trigger" title="本地运行环境" onClick={() => { const next = diagnosticClicks + 1; if (next >= 5) { setDiagnosticClicks(0); onOpenDiagnostics(); } else setDiagnosticClicks(next); }}>本地运行环境</button>
  </>;
}

function DiagnosticsPage({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<OperationalLogEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [level, setLevel] = useState<OperationalLogLevel | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    setLoading(true);
    setMessage('');
    try {
      const result = await window.desktopApi.diagnostics.list({ limit: 500, level, keyword: keyword.trim() || undefined });
      setEntries(result as OperationalLogEntry[]);
      setSelectedIndex(0);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取诊断日志失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [level]);

  const openFolder = async () => {
    setMessage('');
    try { await window.desktopApi.diagnostics.openFolder(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法打开日志目录'); }
  };
  const exportLogs = async () => {
    setMessage('');
    try {
      const result = await window.desktopApi.diagnostics.export() as { path: string; count: number } | null;
      setMessage(result ? `已导出 ${result.count} 条脱敏日志：${result.path}` : '已取消导出');
    } catch (error) { setMessage(error instanceof Error ? error.message : '导出诊断日志失败'); }
  };

  const selectedLog = entries[selectedIndex] ?? entries[0];
  return <>
    <PageHeader eyebrow="本地运维 / 诊断" title="运行诊断中心" description="供开发与运维排查本机运行问题；日志只保存在本机，并在写入时自动隐藏常见凭据。" action={<button className="secondary" onClick={onClose}>返回设置</button>} />
    <section className="panel diagnostics-panel">
      <div className="diagnostics-toolbar">
        <div className="diagnostics-filters">
          <label><span>日志级别</span><select value={level} onChange={(event) => setLevel(event.target.value as OperationalLogLevel | 'all')}><option value="all">全部</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select></label>
          <label><span>关键词</span><input value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void load(); }} placeholder="来源或错误内容" /></label>
          <button className="primary" disabled={loading} onClick={() => void load()}>{loading ? '读取中…' : '查询 / 刷新'}</button>
        </div>
        <div className="button-row"><button className="secondary" onClick={() => void openFolder()}>打开日志目录</button><button className="secondary" onClick={() => void exportLogs()}>导出诊断日志</button></div>
      </div>
      <div className="diagnostics-notice">日志按天记录，单文件达到 5 MB 后自动分卷，并保留最近 14 天。日志已自动脱敏，但导出前仍建议由运维人员复核。</div>
      {message && <div className="message page-message">{message}</div>}
      <div className="diagnostics-workbench"><div className="diagnostics-list" aria-label="诊断记录">
        {entries.map((entry, index) => <button className={`diagnostics-row ${index === selectedIndex ? 'selected' : ''}`} aria-pressed={index === selectedIndex} key={`${entry.timestamp}-${index}`} onClick={() => setSelectedIndex(index)}>
          <time className="diagnostics-time">{new Date(entry.timestamp).toLocaleString()}</time>
          <span className={`diagnostics-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
          <span className="diagnostics-summary"><strong className="diagnostics-source">{entry.source}</strong><span className="diagnostics-excerpt">{entry.message.split('\n')[0]}</span></span>
        </button>)}
        {!loading && !entries.length && <div className="empty">当前筛选条件下暂无日志</div>}
      </div><section className="diagnostics-detail" aria-label="日志详情"><h3>日志详情</h3>{selectedLog ? <><dl><div><dt>记录时间</dt><dd>{new Date(selectedLog.timestamp).toLocaleString()}</dd></div><div><dt>日志级别</dt><dd><span className={`diagnostics-level ${selectedLog.level}`}>{selectedLog.level.toUpperCase()}</span></dd></div><div><dt>模块来源</dt><dd>{selectedLog.source}</dd></div></dl><h4>记录内容</h4><pre className="diagnostics-message">{selectedLog.message}</pre><p>内容来自本机日志，常见凭据已脱敏。未从原始请求推断或补写任何字段。</p></> : <p className="muted">选择左侧记录查看脱敏内容。</p>}</section></div>
    </section>
  </>;
}
