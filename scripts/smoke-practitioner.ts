import { PractitionerClient } from '../src/plugins/transport-practitioner/client';
import { queryPractitionerCategory } from '../src/plugins/transport-practitioner/query';
import { NodeSqliteDriver } from '../src/core/storage/database';
import { SqliteLocalRepository } from '../src/core/storage/sqlite-repository';
import { DefaultLocalSyncEngine } from '../src/core/sync/engine';

const localDate = (value: Date): string => {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
};

const today = new Date();
const fiveDayStart = new Date(today);
fiveDayStart.setDate(today.getDate() - 4);
const startDate = process.env.DATA_FUSION_PRACTITIONER_SMOKE_START ?? localDate(fiveDayStart);
const endDate = process.env.DATA_FUSION_PRACTITIONER_SMOKE_END ?? localDate(today);

const client = new PractitionerClient();
await client.login();
const context = {
  page: 1,
  pageSize: 200_000,
  filters: { startDate, endDate },
};
const [roadResult, taxiResult] = await Promise.all([
  queryPractitionerCategory(client, 'road', context),
  queryPractitionerCategory(client, 'taxi', context),
]);
const total = roadResult.total + taxiResult.total;
const counts = { 道路运输从业人员: roadResult.total, 出租车驾驶员: taxiResult.total };

let committed: { inserted: number; updated: number; unchanged: number } | undefined;
const databasePath = process.env.DATA_FUSION_PRACTITIONER_SMOKE_DB?.trim();
if (databasePath) {
  const repository = new SqliteLocalRepository(new NodeSqliteDriver(databasePath));
  await repository.initialize();
  try {
    const sync = new DefaultLocalSyncEngine(repository);
    const roadPreview = await sync.preview('transport-practitioner', 'road-practitioner-return', ['xkXdrZjhm', 'xkJdrq'], roadResult.rows);
    const taxiPreview = await sync.preview('transport-practitioner', 'taxi-driver-return', ['xkXdrZjhm', 'xkJdrq'], taxiResult.rows);
    await sync.commit('transport-practitioner', 'road-practitioner-return', roadPreview);
    await sync.commit('transport-practitioner', 'taxi-driver-return', taxiPreview);
    committed = {
      inserted: roadPreview.inserted + taxiPreview.inserted,
      updated: roadPreview.updated + taxiPreview.updated,
      unchanged: roadPreview.unchanged + taxiPreview.unchanged,
    };
  } finally {
    await repository.close();
  }
}

// Deliberately report aggregate counts only: source rows contain personal information.
console.log(JSON.stringify({ ok: true, startDate, endDate, total, categories: counts, committed }));
