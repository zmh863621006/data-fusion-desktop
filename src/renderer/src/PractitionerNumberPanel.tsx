import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PractitionerNumberConfig } from '../../core/config/practitioner-numbers';

export function nextPractitionerNumber(item: PractitionerNumberConfig): string {
  const road = item.matterId === 'road-practitioner-return';
  const match = item.latestNumber.trim().match(road ? /^惠交从（许可）字（(\d{4})）(\d{8})号$/ : /^(\d{4})(\d{6})$/);
  if (!match || Number(match[1]) !== item.year) return '';
  const serial = Number(match[2]) + 1;
  const width = road ? 8 : 6;
  if (serial >= 10 ** width) return '';
  const digits = String(serial).padStart(width, '0');
  return road ? `惠交从（许可）字（${item.year}）${digits}号` : `${item.year}${digits}`;
}

export function PractitionerNumberPanel({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const [year, setYear] = useState(new Date().getFullYear());
  const [items, setItems] = useState<PractitionerNumberConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = async () => {
    setBusy(true); setMessage(''); setItems([]);
    try { setItems(await window.desktopApi.practitionerNumbers.get(year)); }
    catch (error) { setMessage(error instanceof Error ? error.message : '读取编号配置失败'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [year]);
  const save = async (item: PractitionerNumberConfig) => {
    setBusy(true); setMessage('');
    try {
      await window.desktopApi.practitionerNumbers.save(item);
      const refreshed = await window.desktopApi.practitionerNumbers.get(year);
      setItems(current => current.map(value => value.matterId === item.matterId ? refreshed.find(fresh => fresh.matterId === item.matterId)! : value));
      setMessage('已保存，后续新增许可从下一号开始。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialogRef} className="practitioner-number-dialog" aria-labelledby="practitioner-number-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="number-dialog-header"><div><span className="eyebrow">从业人员</span><h2 id="practitioner-number-title">许可文书号配置</h2></div><button className="secondary" autoFocus disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="number-dialog-body">
    <p className="number-description">填写最后一个已使用的完整编号。后续新增许可自动续号，已有许可保留原编号。</p>
    <label className="number-year"><span>编号年份</span><select aria-label="编号年份" value={year} disabled={busy} onChange={event => setYear(Number(event.target.value))}>{Array.from({ length: 12 }, (_, i) => new Date().getFullYear() - 9 + i).map(value => <option key={value} value={value}>{value} 年</option>)}</select></label>
    <div className="practitioner-number-grid">{items.map(item => <div className="number-business" key={item.matterId}>
      <h4>{item.matterId === 'road-practitioner-return' ? '道路运输从业人员' : '出租车驾驶员'}</h4>
      <label><span>最后已用编号</span><input aria-label={`${item.matterId === 'road-practitioner-return' ? '道路运输从业人员' : '出租车驾驶员'}最后已用编号`} value={item.latestNumber} disabled={busy} maxLength={80} placeholder={item.matterId === 'road-practitioner-return' ? `惠交从（许可）字（${year}）00010962号` : `${year}006755`} onChange={event => setItems(current => current.map(value => value.matterId === item.matterId ? { ...value, latestNumber: event.target.value } : value))} /></label>
      <div className="number-preview"><span>下一条编号</span><strong>{nextPractitionerNumber(item) || '请填写对应年份的完整编号，保留前导零'}</strong></div>
      <button className="primary" disabled={busy || !nextPractitionerNumber(item)} onClick={() => void save(item)}>保存{item.matterId === 'road-practitioner-return' ? '道路运输' : '出租车'}编号</button>
    </div>)}</div>
    </div><footer className="number-dialog-footer">
    {busy && <p role="status">正在处理…</p>}
    {message && <div className="message page-message" role="status">{message}</div>}
    <button className="text-button" disabled={busy} onClick={() => void load()}>重新读取当前编号</button>
  </footer></dialog>, document.body);
}
