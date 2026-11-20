import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, safeStorage: {} }));
import { PractitionerNumbers, ROAD, TAXI } from '../core/config/practitioner-numbers';
import type { LicenseGrant } from '../core/license/types';
import { NodeSqliteDriver } from '../core/storage/database';
import { SqlitePlatformStore } from '../core/storage/platform-store';
import { AppRuntime } from './runtime';

const system = 'transport-practitioner';
let db: NodeSqliteDriver;
let numbers: PractitionerNumbers;
let runtime: AppRuntime;
let grant: LicenseGrant;

beforeEach(async () => {
  db = new NodeSqliteDriver(':memory:');
  numbers = new PractitionerNumbers(db);
  await numbers.initialize();
  runtime = new AppRuntime();
  Object.assign(runtime, { platformStore: new SqlitePlatformStore(db), practitionerNumbers: numbers });
  grant = { licenseId: 'numbering-fixture', allowedSystems: [system], expiresAt: Date.now() + 60_000 };
  vi.spyOn(runtime, 'currentGrant').mockImplementation(async () => grant);
});
afterEach(() => db.close());

it('reads and writes only the authorized numbering sequences', async () => {
  const [road, taxi] = await runtime.listPractitionerNumbers(2026);
  expect([road.matterId, taxi.matterId]).toEqual([ROAD, TAXI]);
  grant.allowedMatters = { [system]: [TAXI] };
  const read = vi.spyOn(db, 'get');
  expect(await runtime.listPractitionerNumbers(2026)).toEqual([taxi]);
  expect(read.mock.calls.map(([, params]) => params)).toEqual([[TAXI, 2026]]);
  await runtime.savePractitionerNumber({ ...taxi, latestNumber: '2026007000' });
  await expect(runtime.savePractitionerNumber({ ...road, latestNumber: '惠交从（许可）字（2026）00012000号' })).rejects.toThrow('LICENSE_MATTER_DENIED');
  expect(await numbers.list(2026)).toEqual([road, { ...taxi, latestNumber: '2026007000', version: taxi.version + 1 }]);
  grant.allowedMatters = { [system]: [] };
  expect(await runtime.listPractitionerNumbers(2026)).toEqual([]);
  grant.allowedSystems = [];
  await expect(runtime.listPractitionerNumbers(2026)).rejects.toThrow('LICENSE_SYSTEM_DENIED');
});

it('filters a sequence revoked while the read is in progress', async () => {
  vi.mocked(runtime.currentGrant).mockResolvedValueOnce(grant).mockResolvedValueOnce({
    ...grant, allowedMatters: { [system]: [TAXI] },
  });
  expect((await runtime.listPractitionerNumbers(2026)).map(item => item.matterId)).toEqual([TAXI]);
});

it('rejects a save queued before revocation when it obtains the database transaction', async () => {
  const [road] = await runtime.listPractitionerNumbers(2026);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const holding = db.transaction(() => wait);
  const save = runtime.savePractitionerNumber({ ...road, latestNumber: '惠交从（许可）字（2026）00012000号' });
  grant.allowedMatters = { [system]: [TAXI] };
  release();
  await holding;
  await expect(save).rejects.toThrow('LICENSE_MATTER_DENIED');
  expect((await numbers.list(2026))[0]).toEqual(road);
  expect(await db.get('SELECT COUNT(*) AS count FROM practitioner_number_audit')).toEqual({ count: 0 });
});
