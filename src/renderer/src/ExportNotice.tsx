import { useEffect, useRef, useState } from 'react';
import { AppIcon } from './AppIcon';

export type ExportResult = { path: string; rowCount: number; warningCount?: number };

export async function revealExportFolder(path: string, openFolder: (path: string) => Promise<boolean>): Promise<string> {
  try {
    return await openFolder(path) ? '' : '未能打开文件夹，请确认文件仍存在后重试。';
  } catch {
    return '打开文件夹失败，请稍后重试。文件已成功导出。';
  }
}

export function ExportNotice({ result }: { result: ExportResult }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const openingRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setError('');
    return () => { generation.current += 1; };
  }, [result.path]);
  const openFolder = async () => {
    if (openingRef.current) return;
    const current = generation.current;
    openingRef.current = true; setOpening(true); setError('');
    try {
      const message = await revealExportFolder(result.path, path => window.desktopApi.exports.openFolder(path));
      if (current === generation.current) setError(message);
    } finally {
      openingRef.current = false; setOpening(false);
    }
  };
  return <section className="export-notice page-message" aria-label="导出结果">
    <div className="export-notice-summary" role="status"><AppIcon name="check" size={18} /><strong>已导出 {result.rowCount} 条数据</strong></div>
    {Boolean(result.warningCount) && <p className="export-notice-warning"><AppIcon name="warning" size={16} />其中 {result.warningCount} 条存在填写问题，已整行标红，请核对单元格批注。</p>}
    <div className="export-notice-location"><span>保存位置</span><button type="button" className="export-notice-path" title="打开文件所在文件夹" aria-label={`打开文件所在文件夹：${result.path}`} aria-busy={opening} disabled={opening} onClick={() => void openFolder()}>{result.path}</button><small>{opening ? '正在打开文件夹…' : '点击路径打开文件所在文件夹'}</small></div>
    {error && <p className="export-notice-error" role="alert">{error}</p>}
  </section>;
}
