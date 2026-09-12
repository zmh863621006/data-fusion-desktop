import { useEffect, useMemo, useState } from 'react';

type SessionState = {
  status: 'logged-out' | 'logging-in' | 'authenticated' | 'expiring' | 'expired';
  systemId: string;
  expiresAt?: number;
  displayName?: string;
};

type SystemSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
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
  description?: string;
  querySchema: QueryFieldSchema[];
  uniqueKey: string[];
};

export function App() {
  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState<string>('');
  const [matters, setMatters] = useState<MatterSummary[]>([]);
  const [selectedMatterId, setSelectedMatterId] = useState<string>('');
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const selectedSystem = useMemo(
    () => systems.find((item) => item.id === selectedSystemId),
    [systems, selectedSystemId],
  );

  const selectedMatter = useMemo(
    () => matters.find((item) => item.id === selectedMatterId),
    [matters, selectedMatterId],
  );

  async function reloadSystems() {
    const result = (await window.desktopApi.systems.list()) as SystemSummary[];
    setSystems(result);
    if (!selectedSystemId && result[0]) setSelectedSystemId(result[0].id);
  }

  useEffect(() => {
    void reloadSystems();
  }, []);

  useEffect(() => {
    if (!selectedSystemId) return;
    window.desktopApi.matters.list(selectedSystemId).then((result) => {
      const list = result as MatterSummary[];
      setMatters(list);
      setSelectedMatterId(list[0]?.id ?? '');
      setFilters({});
      setRows([]);
    });
  }, [selectedSystemId]);

  async function login() {
    if (!selectedSystemId) return;
    setLoading(true);
    setMessage('正在登录业务系统…');
    try {
      await window.desktopApi.systems.login(selectedSystemId);
      await reloadSystems();
      setMessage('业务系统登录成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  async function query() {
    if (!selectedSystemId || !selectedMatterId) return;
    setLoading(true);
    setMessage('正在查询…');
    try {
      const result = (await window.desktopApi.matters.query(selectedSystemId, selectedMatterId, {
        page: 1,
        pageSize: 50,
        filters,
      })) as { rows: Record<string, unknown>[]; total: number };
      setRows(result.rows);
      setMessage(`查询完成，共 ${result.total} 条`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '查询失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">融</div>
          <div>
            <strong>数据融合助手</strong>
            <span>Local Data Workspace</span>
          </div>
        </div>

        <nav>
          <button className="nav-item active">工作台</button>
          <div className="nav-title">业务系统</div>
          {systems.map((system) => (
            <button
              key={system.id}
              className={`nav-item ${system.id === selectedSystemId ? 'active' : ''}`}
              onClick={() => setSelectedSystemId(system.id)}
            >
              {system.name}
            </button>
          ))}
          <div className="nav-title">本地工具</div>
          <button className="nav-item">本地数据</button>
          <button className="nav-item">同步任务</button>
          <button className="nav-item">设置</button>
        </nav>

        <div className="local-note">业务数据仅保存在本机</div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <div className="eyebrow">当前模块</div>
            <h1>{selectedSystem?.name ?? '加载中…'}</h1>
          </div>
          <div className="session-box">
            <span className={`dot ${selectedSystem?.session.status === 'authenticated' ? 'online' : ''}`} />
            <span>{selectedSystem?.session.status === 'authenticated' ? '业务系统已登录' : '业务系统未登录'}</span>
            <button onClick={login} disabled={loading || !selectedSystemId}>
              {selectedSystem?.session.status === 'authenticated' ? '重新登录' : '登录系统'}
            </button>
          </div>
        </header>

        <section className="hero-card">
          <div>
            <span className="pill">插件 v{selectedSystem?.version ?? '-'}</span>
            <h2>先登录原业务系统，再进行事项查询</h2>
            <p>应用本身不建立用户账号体系；登录凭据由对应系统插件在主进程中维护。</p>
          </div>
          <div className="hero-status">
            <span>会话状态</span>
            <strong>{selectedSystem?.session.status ?? '-'}</strong>
          </div>
        </section>

        <section className="workspace-grid">
          <div className="panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">STEP 1</span>
                <h3>选择业务事项</h3>
              </div>
            </div>
            <div className="matter-list">
              {matters.map((matter) => (
                <button
                  key={matter.id}
                  className={`matter-card ${matter.id === selectedMatterId ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedMatterId(matter.id);
                    setFilters({});
                    setRows([]);
                  }}
                >
                  <strong>{matter.name}</strong>
                  <span>{matter.description}</span>
                  <small>唯一键：{matter.uniqueKey.join(' + ')}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="panel query-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">STEP 2</span>
                <h3>{selectedMatter?.name ?? '查询条件'}</h3>
              </div>
            </div>

            <div className="form-grid">
              {selectedMatter?.querySchema.map((field) => (
                <label key={field.key}>
                  <span>{field.label}{field.required ? ' *' : ''}</span>
                  {field.type === 'select' ? (
                    <select
                      value={String(filters[field.key] ?? '')}
                      onChange={(event) => setFilters((old) => ({ ...old, [field.key]: event.target.value }))}
                    >
                      {field.options?.map((option) => (
                        <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      placeholder={field.placeholder ?? `请输入${field.label}`}
                      value={String(filters[field.key] ?? '')}
                      onChange={(event) => setFilters((old) => ({ ...old, [field.key]: event.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>

            <div className="actions">
              <button className="secondary" onClick={() => setFilters({})}>清空条件</button>
              <button className="primary" onClick={query} disabled={loading}>执行查询</button>
            </div>
            {message && <div className="message">{message}</div>}
          </div>
        </section>

        <section className="panel result-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">STEP 3</span>
              <h3>查询结果预览</h3>
            </div>
            <span className="muted">当前阶段仅预览，后续接本地去重与写入</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty">暂无查询结果</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>{Object.keys(rows[0]).map((key) => <th key={key}>{key}</th>)}</tr>
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
        </section>
      </main>
    </div>
  );
}
