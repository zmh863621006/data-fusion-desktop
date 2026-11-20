import { useMemo, useState } from 'react';
import { Button, Checkbox, Input } from 'antd';
import { RightOutlined, SearchOutlined } from '@ant-design/icons';
import { emptyScope, filterScopeDirectory, scopeDirectory, scopeItemSelected, selectScopeItems, type LicenseScopeValues, type ScopeItem } from './license-scope';
import type { BootstrapData } from './types';

type PickerProps = {
  data: Pick<BootstrapData, 'systems' | 'matters' | 'tools'>;
  initial?: LicenseScopeValues;
  value?: LicenseScopeValues;
  onChange?: (value: LicenseScopeValues) => void;
  disabled?: boolean;
  id?: string;
};

export function LicenseScopePicker({ data, initial = emptyScope, value = emptyScope, onChange, disabled, id }: PickerProps) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const directory = useMemo(() => scopeDirectory(data, initial), [data.systems, data.matters, initial]);
  const visible = filterScopeDirectory(directory, search);
  const items = visible.flatMap(system => system.items);
  const filtered = Boolean(search.trim());
  const selected = (item: ScopeItem) => scopeItemSelected(value, item);
  const apply = (rows: ScopeItem[], checked: boolean) => { if (!disabled) onChange?.(selectScopeItems(value, rows, checked)); };
  const knownTools = new Map((data.tools ?? []).map(tool => [tool.id, tool.name]));
  const tools = [...new Set([...knownTools.keys(), ...initial.allowedTools])];
  const selectedMatters = Object.values(value.allowedMatters).reduce((total, ids) => total + ids.length, 0);

  function branch(key: string, name: string, rows: ScopeItem[], hasChildren: boolean) {
    const count = rows.filter(selected).length;
    const available = rows.filter(row => row.available || selected(row)).length;
    const checked = count > 0 && count === available;
    const open = filtered || expanded.includes(key);
    return <div className="scope-branch">
      <Checkbox aria-label={`${name}（${filtered ? '匹配范围' : '全部范围'}）`} checked={checked} indeterminate={count > 0 && !checked}
        disabled={disabled || !available} onChange={() => apply(rows, !checked)} />
      {hasChildren ? <button type="button" className="scope-disclosure" aria-expanded={open} disabled={disabled || filtered}
        onClick={() => setExpanded(previous => previous.includes(key) ? previous.filter(id => id !== key) : [...previous, key])}>
        <RightOutlined rotate={open ? 90 : 0} /><span>{name}</span>
      </button> : <span className="scope-branch-name">{name}</span>}
      <span className="scope-count">{hasChildren ? `${count} / ${rows.length}` : count ? '已选' : available ? '无下级事项' : '暂无可授权事项'}</span>
    </div>;
  }
  return <div className="scope-picker" id={id}>
    <Input allowClear prefix={<SearchOutlined />} placeholder="搜索系统、部门或事项" aria-label="搜索系统、部门或事项"
      value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />
    <div className="scope-toolbar">
      <span aria-live="polite">已选 {value.allowedSystems.length} 个系统 · {selectedMatters} 个事项 · {value.allowedTools.length} 个工具</span>
      <div><Button type="link" disabled={disabled || !items.some(item => item.available && !selected(item))} onClick={() => apply(items, true)}>{filtered ? '全选匹配业务' : '全选业务'}</Button>
        <Button type="link" disabled={disabled || !items.some(selected)} onClick={() => apply(items, false)}>{filtered ? '取消匹配业务' : '取消全部业务'}</Button></div>
    </div>
    <div className="scope-systems" role="group" aria-label="授权业务系统">
      {!visible.length && <div className="scope-no-results">{filtered ? '没有匹配的系统、部门或事项' : '暂无业务系统'}</div>}
      {visible.map(system => {
        const hasMatters = system.items.some(item => item.matterId !== undefined);
        const departmentNames = [...new Set(system.items.map(item => item.department))];
        return <div className="scope-system" key={system.id}>
          {branch(system.id, system.name + (system.enabled ? '' : '（已停用或下线）'), system.items, hasMatters)}
          {hasMatters && (filtered || expanded.includes(system.id)) && departmentNames.map(department => {
            const rows = system.items.filter(item => item.department === department);
            const key = JSON.stringify([system.id, department]);
            return <div className="scope-department" key={key}>
              {branch(key, department, rows, true)}
              {(filtered || expanded.includes(key)) && <div className="scope-leaves">{rows.map(item => <Checkbox key={item.matterId ?? system.id}
                checked={selected(item)} disabled={disabled || (!item.available && !selected(item))} onChange={event => apply([item], event.target.checked)}>
                {item.name}{item.available ? '' : '（已停用或下线）'}
              </Checkbox>)}</div>}
            </div>;
          })}
        </div>;
      })}
    </div>
    <fieldset className="scope-tools"><legend>授权工具</legend>{tools.map(tool => {
      const checked = value.allowedTools.includes(tool);
      return <Checkbox key={tool} checked={checked} disabled={disabled || (!knownTools.has(tool) && !checked)}
        onChange={event => onChange?.({ ...value, allowedTools: event.target.checked ? [...value.allowedTools, tool] : value.allowedTools.filter(id => id !== tool) })}>
        {knownTools.get(tool) ?? `${tool}（已下线）`}
      </Checkbox>;
    })}{!tools.length && <span>暂无工具</span>}</fieldset>
  </div>;
}
