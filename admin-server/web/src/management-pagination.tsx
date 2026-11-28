import { useCallback, useEffect, useRef, useState } from 'react';
import { Select, type SelectProps } from 'antd';
import type { ActionType } from '@ant-design/pro-components';
import { request } from './api';
import type { BootstrapData, CustomerRecord } from './types';

export interface ManagementPage<T> { rows: T[]; total: number; page: number; pageSize: number }
export function listManagement<T>(kind: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key === 'current' ? 'page' : key, String(value));
  return request<ManagementPage<T>>(`/api/admin/${kind}?${query}`, { signal });
}
export function useManagementTable<T>(data: BootstrapData, kind: string, extra: Record<string, unknown> = {}) {
  const actionRef = useRef<ActionType>(undefined), previous = useRef(data);
  useEffect(() => {
    if (data.paginated && previous.current !== data) void actionRef.current?.reload();
    previous.current = data;
  }, [data]);
  const fetchRows = useCallback(async (params: Record<string, unknown>) => {
    const result = await listManagement<T>(kind, params);
    return { data: result.rows, total: result.total, success: true };
  }, [kind]);
  return data.paginated ? { actionRef, request: fetchRows, params: extra } : {};
}

export function CustomerSelect({ data, enabledOnly = false, ...props }: SelectProps<string> & { data: BootstrapData; enabledOnly?: boolean }) {
  const [search, setSearch] = useState(''), [rows, setRows] = useState<CustomerRecord[]>([]), [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (!data.paginated) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setLoadError(false);
      void listManagement<CustomerRecord>('customers', { name: search, enabled: enabledOnly ? 1 : undefined, pageSize: 50 }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setRows(previous => {
          const selected = previous.filter(row => row.id === props.value && !result.rows.some(item => item.id === row.id));
          return [...selected, ...result.rows];
        }); }).catch(() => { if (!controller.signal.aborted) setLoadError(true); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [data.paginated, data, search, enabledOnly]);
  const options = (data.paginated ? rows : data.customers.filter(row => !enabledOnly || row.enabled)).map(row => ({ value: row.id, label: row.name }));
  return <Select<string> {...props} allowClear showSearch loading={loading} onSearch={setSearch}
    filterOption={data.paginated ? false : undefined} optionFilterProp="label" options={options}
    notFoundContent={loadError ? '客户列表读取失败，请重新搜索' : loading ? '正在读取客户…' : '未找到客户'} />;
}
