import type { DatabaseDriver } from '../storage/database';
import { buildRecordKey } from '../sync/engine';

export type PractitionerNumberConfig = { matterId: string; year: number; latestNumber: string; version: number };
export const ROAD = 'road-practitioner-return';
export const TAXI = 'taxi-driver-return';
const SYSTEM = 'transport-practitioner';

export function numberParts(matter: string, value: string): [number, number] {
  const pattern = matter === ROAD ? /^惠交从（许可）字（(\d{4})）(\d{8})号$/ : matter === TAXI ? /^(\d{4})(\d{6})$/ : null;
  const match = pattern?.exec(value.trim());
  if (!match || Number(match[1]) < 2000) throw new Error('请输入正确的完整编号，保留年份和前导零');
  return [Number(match[1]), Number(match[2])];
}
export function formatNumber(matter: string, year: number, serial: number): string {
  const width = matter === ROAD ? 8 : matter === TAXI ? 6 : 0;
  if (!width || !Number.isInteger(serial) || serial < 0 || serial >= 10 ** width) throw new Error('流水号超出范围');
  const digits = String(serial).padStart(width, '0');
  return matter === ROAD ? `惠交从（许可）字（${year}）${digits}号` : `${year}${digits}`;
}
export class PractitionerNumbers {
  constructor(private readonly db: DatabaseDriver) {}
  async initialize() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS practitioner_numbers(matter TEXT NOT NULL,year INTEGER NOT NULL,serial INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(matter,year));
      CREATE TABLE IF NOT EXISTS practitioner_number_map(matter TEXT NOT NULL,record_key TEXT NOT NULL,number TEXT NOT NULL,PRIMARY KEY(matter,record_key),UNIQUE(matter,number));
      CREATE TABLE IF NOT EXISTS practitioner_number_audit(id INTEGER PRIMARY KEY, matter TEXT,year INTEGER,old_serial INTEGER,new_serial INTEGER,created_at INTEGER);`);
    await this.db.run('INSERT OR IGNORE INTO practitioner_numbers(matter,year,serial) VALUES(?,2026,10962)', [ROAD]);
    await this.db.run('INSERT OR IGNORE INTO practitioner_numbers(matter,year,serial) VALUES(?,2026,6755)', [TAXI]);
  }
  async list(year: number): Promise<PractitionerNumberConfig[]> {
    if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('年份不正确');
    return this.db.transaction(async () => Promise.all([ROAD, TAXI].map(async matterId => {
      const row = await this.db.get<{ serial: number; version: number }>('SELECT serial,version FROM practitioner_numbers WHERE matter=? AND year=?', [matterId, year]);
      return { matterId, year, latestNumber: row ? formatNumber(matterId, year, row.serial) : '', version: row?.version ?? -1 };
    })));
  }
  async save(config: PractitionerNumberConfig) {
    const [year, serial] = numberParts(config.matterId, config.latestNumber);
    if (year !== config.year || !Number.isInteger(config.version)) throw new Error('编号年份与所选年份不一致');
    formatNumber(config.matterId, year, serial + 1);
    await this.db.transaction(async () => {
      const old = await this.db.get<{ serial: number; version: number }>('SELECT serial,version FROM practitioner_numbers WHERE matter=? AND year=?', [config.matterId, year]);
      if ((old?.version ?? -1) !== config.version) throw new Error('编号已更新，请刷新配置后再保存');
      await this.db.run('INSERT INTO practitioner_numbers(matter,year,serial,version) VALUES(?,?,?,0) ON CONFLICT(matter,year) DO UPDATE SET serial=excluded.serial,version=version+1', [config.matterId, year, serial]);
      await this.db.run('INSERT INTO practitioner_number_audit(matter,year,old_serial,new_serial,created_at) VALUES(?,?,?,?,?)', [config.matterId, year, old?.serial, serial, Date.now()]);
    });
  }
  /** Number allocation and local sync/output commit share one SQLite transaction. */
  async withNumbers<T>(matter: string, rows: Record<string, unknown>[], commit: (rows: Record<string, unknown>[]) => Promise<T>): Promise<T> {
    if (![ROAD, TAXI].includes(matter)) throw new Error('不支持的从业事项');
    return this.db.transaction(async () => {
      const numbered: Record<string, unknown>[] = [];
      const ordered = [...rows].sort((a, b) => String(a.xkJdrq).localeCompare(String(b.xkJdrq)) || String(a.xkXdrZjhm).localeCompare(String(b.xkXdrZjhm)));
      for (const row of ordered) {
        const key = buildRecordKey(row, ['xkXdrZjhm', 'xkJdrq']);
        const date = String(row.xkJdrq ?? '').slice(0, 10);
        if (!row.xkXdrZjhm || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('记录缺少证件号码或决定日期，无法分配编号');
        const year = Number(date.slice(0, 4));
        const mapped = await this.db.get<{ number: string }>('SELECT number FROM practitioner_number_map WHERE matter=? AND record_key=?', [matter, key]);
        const previous = await this.db.get<{ data_json: string }>('SELECT data_json FROM local_records WHERE system_id=? AND matter_id=? AND record_key=?', [SYSTEM, matter, key]);
        const oldNumber = previous ? String(JSON.parse(previous.data_json).xkWsh ?? '').trim() : '';
        if (mapped && oldNumber && mapped.number !== oldNumber) throw new Error('本地文书号与编号台账不一致，请先核对该记录');
        let number = mapped?.number ?? oldNumber;
        if (!number) {
          const config = await this.db.get<{ serial: number }>('SELECT serial FROM practitioner_numbers WHERE matter=? AND year=?', [matter, year]);
          if (!config) throw new Error(`${year}年编号尚未配置，请先设置最后已用编号`);
          number = formatNumber(matter, year, config.serial + 1);
          const collision = await this.db.get('SELECT 1 FROM local_records WHERE system_id=? AND matter_id=? AND json_extract(data_json,\'$.xkWsh\')=? UNION ALL SELECT 1 FROM practitioner_number_map WHERE matter=? AND number=? LIMIT 1', [SYSTEM, matter, number, matter, number]);
          if (collision) throw new Error(`下一编号 ${number} 已被使用，请调整编号配置`);
          await this.db.run('UPDATE practitioner_numbers SET serial=serial+1,version=version+1 WHERE matter=? AND year=?', [matter, year]);
        }
        if (!mapped) await this.db.run('INSERT INTO practitioner_number_map(matter,record_key,number) VALUES(?,?,?)', [matter, key, number]);
        numbered.push({ ...row, xkWsh: number });
      }
      return commit(numbered);
    });
  }
}
