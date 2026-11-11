import { it, expect } from 'vitest';
import { NodeSqliteDriver } from '../storage/database';
import { SqliteLocalRepository } from '../storage/sqlite-repository';
import { SqlitePlatformStore } from '../storage/platform-store';

it('enterprise results backfill current and historical snapshots without overwriting concurrent edits or changing pagination order',async()=>{
  const driver=new NodeSqliteDriver(':memory:');
  try {
    const repository=new SqliteLocalRepository(driver);await repository.initialize();
    const store=new SqlitePlatformStore(driver);await store.initialize();
    await store.save({id:'task',type:'data-return',name:'测试',status:'completed',progress:{current:1,total:1},createdAt:1});
    const original={id:'1',qymc:'错字公司'},enriched={...original,frdb:'后台法人'};
    await repository.upsert({systemId:'government-info',matterId:'matter',recordKey:'1',data:original,firstSeenAt:1,updatedAt:2});
    await store.replaceTaskOutput('task','government-info','matter',[{recordKey:'1',data:original}]);
    await store.applyEnterpriseEnrichment('government-info','matter','1',original,enriched);
    expect((await repository.find('government-info','matter','1'))?.data).toEqual(enriched);
    expect((await repository.find('government-info','matter','1'))?.updatedAt).toBe(2);
    expect((await store.listTaskOutput('task')).rows[0].data).toEqual(enriched);
    expect(await repository.listVersions('government-info','matter','1')).toHaveLength(1);
    await store.updateRecord('government-info','matter','1','1',{...enriched,frdb:'手工法人'});
    await store.applyEnterpriseEnrichment('government-info','matter','1',enriched,{...enriched,frdb:'后台新法人'});
    expect((await repository.find('government-info','matter','1'))?.data.frdb).toBe('手工法人');
    expect((await store.listTaskOutput('task')).rows[0].data.frdb).toBe('后台新法人');
    expect(await repository.listVersions('government-info','matter','1')).toHaveLength(2);
  } finally { await driver.close(); }
});
