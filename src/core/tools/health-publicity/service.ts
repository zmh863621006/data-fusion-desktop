import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { DatabaseDriver } from '../../storage/database';
import type { StoredRecord } from '../../storage/types';
import { DOUBLE_PUBLICITY_KEYS } from '../../double-publicity/template';
import { readHealthDocx } from './parser';
import type { HealthImportResult, HealthPublicityDocument, HealthPublicityState } from './types';

export class HealthPublicityService {
  constructor(private readonly database: DatabaseDriver) {}

  async initialize(): Promise<void> {
    await this.database.exec(`CREATE TABLE IF NOT EXISTS health_publicity_documents(
      id TEXT PRIMARY KEY, document_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS health_publicity_settings(id INTEGER PRIMARY KEY CHECK(id=1),authority_code TEXT NOT NULL);`);
  }

  async state(): Promise<HealthPublicityState> {
    const settings = await this.database.get<{ authority_code: string }>('SELECT authority_code FROM health_publicity_settings WHERE id=1');
    const documents = await this.database.all<{ document_json: string }>('SELECT document_json FROM health_publicity_documents ORDER BY created_at DESC,rowid DESC LIMIT 500');
    return { authorityCode: settings?.authority_code ?? '', documents: documents.map(row => JSON.parse(row.document_json) as HealthPublicityDocument) };
  }

  async importFiles(paths: string[]): Promise<HealthImportResult> {
    if (!paths.length || paths.length > 50) throw new Error('每次请选择 1–50 份 DOCX 文档');
    let added = 0, duplicates = 0;
    const errors: HealthImportResult['errors'] = [];
    for (const path of paths) {
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('单份 Word 不得超过 20 MB，且必须为普通文件');
        const document = await readHealthDocx(await readFile(path), basename(path));
        if (await this.database.get('SELECT id FROM health_publicity_documents WHERE id=?', [document.id])) { duplicates++; continue; }
        await this.database.transaction(async () => {
          const count = await this.database.get<{ n: number }>('SELECT count(*) n FROM health_publicity_documents');
          if ((count?.n ?? 0) >= 500) throw new Error('本地工具最多保留 500 份文档，请先移除不需要的记录');
          await this.database.run('INSERT INTO health_publicity_documents VALUES(?,?,?)', [document.id, JSON.stringify(document), document.createdAt]);
        });
        added++;
      } catch (error) { errors.push({ fileName: basename(path), message: error instanceof Error ? error.message : '文档读取失败' }); }
    }
    return { state: await this.state(), added, duplicates, errors };
  }

  async update(id: string, patch: Record<string, unknown>): Promise<HealthPublicityState> {
    const row = await this.database.get<{ document_json: string }>('SELECT document_json FROM health_publicity_documents WHERE id=?', [id]);
    if (!row) throw new Error('文档记录不存在');
    const document = JSON.parse(row.document_json) as HealthPublicityDocument;
    for (const [key, value] of Object.entries(patch)) {
      if (!(DOUBLE_PUBLICITY_KEYS as readonly string[]).includes(key) || typeof value !== 'string' || value.length > 30000) throw new Error('可修改的双公示字段或字段长度无效');
      document.data[key] = value.trim();
    }
    await this.database.run('UPDATE health_publicity_documents SET document_json=? WHERE id=?', [JSON.stringify(document), id]);
    return this.state();
  }

  async settings(authorityCode: string): Promise<HealthPublicityState> {
    const value = authorityCode.trim().toUpperCase();
    if (value && !/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(value)) throw new Error('机关统一社会信用代码须为 18 位有效字符，未知请留空');
    await this.database.run('INSERT INTO health_publicity_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET authority_code=excluded.authority_code', [value]);
    return this.state();
  }

  async remove(id: string): Promise<HealthPublicityState> {
    await this.database.run('DELETE FROM health_publicity_documents WHERE id=?', [id]);
    return this.state();
  }

  /** Apply only verified enterprise fields, without changing the Word extraction. */
  async applyEnterpriseResults(before: StoredRecord[], results: Record<string, unknown>[]): Promise<void> {
    if (before.length !== results.length) throw new Error('企业补全结果数量不匹配');
    await this.database.transaction(async () => {
      for (let index = 0; index < before.length; index++) {
        const incoming = results[index], previous = before[index];
        if (!incoming.enterpriseEnrichment) continue;
        const row = await this.database.get<{ document_json: string }>('SELECT document_json FROM health_publicity_documents WHERE id=?', [previous.recordKey]);
        if (!row) continue;
        const document = JSON.parse(row.document_json) as HealthPublicityDocument;
        if (['xkXdrMc', 'xkXdrShxym'].some(key => document.data[key] !== previous.data[key])) continue;
        for (const key of ['xkXdrMc', 'xkXdrShxym', 'xkFrdb']) {
          if (typeof incoming[key] !== 'string' || incoming[key] === previous.data[key] || document.data[key] !== previous.data[key]) continue;
          document.data[key] = incoming[key] as string;
          const enrichment = incoming.enterpriseEnrichment as { enterprise?: { source?: string }; requestId?: string };
          document.evidence[key] = `后台企业信息补全；来源：${enrichment.enterprise?.source ?? '后台企业库'}；查询编号：${enrichment.requestId ?? '无'}。Word 原文与首次提取值保持不变。`;
        }
        document.enterpriseEnrichment = incoming.enterpriseEnrichment as Record<string, unknown>;
        await this.database.run('UPDATE health_publicity_documents SET document_json=? WHERE id=?', [JSON.stringify(document), previous.recordKey]);
      }
    });
  }

  async records(ids: string[]): Promise<StoredRecord[]> {
    const { documents, authorityCode } = await this.state();
    const selected = new Set(ids);
    if (!selected.size || selected.size !== ids.length || ids.length > 500) throw new Error('请选择 1–500 条不同的记录');
    const rows = documents.filter(document => selected.has(document.id));
    if (rows.length !== selected.size) throw new Error('部分文档记录不存在，请刷新后重新选择');
    return rows.map(document => ({ systemId: 'health-publicity', matterId: 'word-to-publicity', recordKey: document.id,
      firstSeenAt: document.createdAt, updatedAt: Date.now(), data: { ...document.data,
        ...(document.enterpriseEnrichment ? { enterpriseEnrichment: document.enterpriseEnrichment } : {}),
        xkXkjgdm: document.data.xkXkjgdm || authorityCode, xkLydwdm: document.data.xkLydwdm || authorityCode } }));
  }
}
