import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalLogService, redactOperationalLogText } from './operational-log';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('operational log redaction', () => {
  it.each([
    'LSID=lsid-secret',
    'sid=sid-secret&next=1',
    'lid=lid-secret',
    'Authorization: Bearer bearer-secret',
    'Cookie: SID=cookie-secret; path=/',
    'DFL1.license-secret',
    '{"password":"password-secret","token":"token-secret"}',
  ])('removes credentials from %s', (input) => {
    const output = redactOperationalLogText(input);
    expect(output).not.toContain('-secret');
    expect(output).toContain('[REDACTED]');
  });

  it('preserves useful operational context', () => {
    expect(redactOperationalLogText('POST /api/export returned 502')).toBe('POST /api/export returned 502');
  });
});

describe('OperationalLogService', () => {
  it('writes, filters and exports sanitized JSONL entries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'data-fusion-log-'));
    temporaryDirectories.push(directory);
    const service = new OperationalLogService();
    service.initialize(directory, '1.2.3');
    service.write('info', 'request', 'request completed');
    service.write('error', 'request', 'sid=raw-secret request failed');

    expect(service.list({ level: 'error' })).toHaveLength(1);
    expect(service.list({ keyword: 'completed' })).toHaveLength(1);
    expect(service.list({ level: 'error' })[0].message).not.toContain('raw-secret');

    const exportPath = join(directory, 'diagnostics.jsonl');
    const result = service.exportTo(exportPath);
    const exported = readFileSync(exportPath, 'utf8');
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(exported).not.toContain('raw-secret');
    expect(exported).toContain('"appVersion":"1.2.3"');
  });
});
