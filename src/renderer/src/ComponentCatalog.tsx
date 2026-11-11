import type { ComponentSummary } from '../../core/plugins/components';
import type { LicenseStatus } from '../../core/license/types';
import { AppIcon, systemIcon } from './AppIcon';
import { shortSystemName } from './ui-format';
import { workspaceAccess } from './workspace-access';

export function ComponentCatalog({ components, license, onOpenSystem, onOpenTool }: {
  components: ComponentSummary[]; license: LicenseStatus;
  onOpenSystem: (id: string) => void; onOpenTool: () => void;
}) {
  const access = workspaceAccess(license);
  const visible = components.filter(component => component.authorized && (component.kind === 'system'
    ? access.canOpenSystem(component.id) : component.id === 'health-publicity' && access.canOpenTool(component.id)));
  return <>
    <header className="page-header"><div><h1>组件管理</h1><p>查看已授权的业务系统与工具，组件随应用统一更新。</p></div></header>
    <section className="panel data-panel component-table" aria-label="已授权组件">
      <table><thead><tr><th>组件名称</th><th>类型</th><th>当前版本</th><th>说明</th><th>操作</th></tr></thead>
        <tbody>{visible.map(component => <tr className="plugin-card" data-component-kind={component.kind} key={`${component.kind}:${component.id}`}>
          <td><div className="component-name"><AppIcon name={component.kind === 'tool' ? 'document' : systemIcon(component.id)} size={24} />
            <span title={component.name}>{component.kind === 'tool' ? component.name : shortSystemName(component.id, component.name)}</span></div></td>
          <td><span className={`component-kind ${component.kind}`}>{component.kind === 'tool' ? '工具' : '业务系统'}</span></td>
          <td className="component-version">v{component.version}</td>
          <td className="component-description" title={component.description}>{component.description || '随应用统一更新'}</td>
          <td><button className="secondary" onClick={() => component.kind === 'tool' ? onOpenTool() : onOpenSystem(component.id)}>{component.kind === 'tool' ? '打开工具' : '进入系统'}</button></td>
        </tr>)}{!visible.length && <tr><td colSpan={5} className="empty">当前密钥没有可用的已授权组件。</td></tr>}</tbody>
      </table>
    </section>
    <p className="component-caption">仅展示当前密钥已授权的组件。工具可独立授权使用，无需登录业务系统。</p>
  </>;
}
