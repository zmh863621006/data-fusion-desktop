import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createEnterpriseStore } from '../enterprises.mjs';
import { createEstablishmentImporter,parseEstablishmentWorkbook } from '../establishment-oss-import.mjs';
import { createOssEstablishmentSource,ossV4Signature } from '../oss-establishment-source.mjs';

const alphabet='0123456789ABCDEFGHJKLMNPQRTUWXY',prefix='91440300123456789';
const code=prefix+alphabet[(31-[1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28].reduce((s,w,i)=>s+alphabet.indexOf(prefix[i])*w,0)%31)%31];
test('V4 matches the official Aliyun SDK signing vector',()=>{
  const query=new URLSearchParams({param1:'value1','+param1':'value3','|param1':'value4','+param2':'','|param2':'',param2:''}).toString();
  assert.equal(ossV4Signature({secret:'sk',region:'cn-hangzhou',timestamp:'20231216T162057Z',method:'PUT',resource:'/bucket/1234%2B-/123/1.txt',query,headers:{'content-type':'text/plain','x-oss-head1':'value','x-oss-content-sha256':'UNSIGNED-PAYLOAD','x-oss-date':'20231216T162057Z'}}),'e21d18daa82167720f9b1047ae7e7f1ce7cb77a31e8203a7d5f4624fa0284afe');
});
async function batch({date='2026-10-22T10:00:00',legal='测试法人',matter='个体工商户开业登记',split=false}={}) {
  const workbook=new ExcelJS.Workbook(),meta=workbook.addWorksheet('Metadata'),sheet=workbook.addWorksheet('Records');
  for(const row of [['schemaVersion','szjx-establishments-v1'],['collectedAt',date],['recordCount','1'],['scope','shenzhen-establishment']])meta.addRow(row);
  sheet.addRow(['源记录ID','网上申请号','主体名称','事项名称','统一社会信用代码','法定代表人姓名','注册地址','受理时间','审批状态','详情JSON',...(split?['详情JSON续1']:[])]);
  const payload=JSON.stringify({DATA_ID:'test-one',APPLY_PARTY_NAME:'测试企业',INFOFLOW_NAME:matter,SourceFormData:{sample:'甲'.repeat(split?40000:1)}});
  sheet.addRow(['test-one','TEST-001','测试企业',matter,code,legal,'测试地址','2026-10-22 09:00:00','已受理',...(split?[payload.slice(0,30000),payload.slice(30000)]:[payload])]);
  const bytes=Buffer.from(await workbook.xlsx.writeBuffer());return {bytes,key:`szjx/establishments/2026-10-22_${createHash('sha256').update(bytes).digest('hex')}.xlsx`};
}
function fixture(t,objects) {
  const db=new DatabaseSync(':memory:');let calls=0;
  createEnterpriseStore(db,{configured:true,provider:async()=>{calls++;throw Error('must not call paid service')},audit:()=>{},transaction:work=>work()});
  const errors=[];const importer=createEstablishmentImporter(db,{source:{list:async()=>objects.map(({key})=>({key})),download:async key=>objects.find(x=>x.key===key).bytes},onError:error=>errors.push(error)});
  t.after(async()=>{await importer.close();db.close()});return {db,importer,errors,calls:()=>calls};
}
test('imports private OSS Excel into raw records and existing enterprise lookup, without paid calls',async t=>{
  const item=await batch({split:true});const {db,importer,calls,errors}=fixture(t,[item]);await importer.poll();
  assert.equal(errors.length,0);assert.equal(calls(),0);assert.equal(db.prepare('SELECT count(*) n FROM establishment_records').get().n,1);
  assert.equal(db.prepare('SELECT legal_person FROM enterprises').get().legal_person,'测试法人');
  assert.equal(db.prepare('SELECT source FROM enterprises').get().source,'szjx-establishment');
  const history=db.prepare('SELECT count(*) n FROM enterprise_history').get().n;await importer.poll();assert.equal(db.prepare('SELECT count(*) n FROM enterprise_history').get().n,history);
});
test('preserves manual canonical data and stores raw incoming evidence for review',async t=>{
  const {db,importer,errors}=fixture(t,[await batch({legal:'来源法人'})]);
  db.prepare('INSERT INTO enterprises(id,name,credit_code,legal_person,source,updated_at) VALUES(?,?,?,?,?,?)').run('manual','测试企业',code,'人工维护法人','manual',1);
  await importer.poll();assert.equal(errors.length,0);assert.equal(db.prepare('SELECT legal_person FROM enterprises').get().legal_person,'人工维护法人');
  assert.equal(db.prepare('SELECT legal_person FROM establishment_records').get().legal_person,'来源法人');assert.equal(db.prepare('SELECT status FROM enterprise_requests').get().status,'review');
});
test('bad checksums and malformed files never produce import receipts',async t=>{
  const item=await batch();item.bytes=Buffer.from('not-a-workbook');const {db,importer,errors}=fixture(t,[item]);await importer.poll();await importer.poll();
  assert.equal(errors.length,2);assert.equal(db.prepare('SELECT count(*) n FROM establishment_batches').get().n,0);
});
test('rejects unrelated business types and handles JSON continuation columns',async()=>{
  const good=await batch({split:true});assert.equal((await parseEstablishmentWorkbook(good.bytes)).length,1);
  const bad=await batch({matter:'内资公司变更登记'});await assert.rejects(parseEstablishmentWorkbook(bad.bytes),/其他业务类型/);
});
test('late older objects cannot downgrade raw observations',async t=>{
  const newer=await batch({date:'2026-10-22T12:00:00',legal:'新法人'}),older=await batch({date:'2026-10-22T10:00:00',legal:'旧法人'});
  const {db,importer,errors}=fixture(t,[newer,older]);await importer.poll();assert.equal(errors.length,0);assert.equal(db.prepare('SELECT legal_person FROM establishment_records').get().legal_person,'新法人');
});
test('OSS listing follows continuation tokens and downloads only the configured prefix',async()=>{
  const item=await batch();const urls=[];
  const source=createOssEstablishmentSource({endpoint:'oss-cn-shenzhen.aliyuncs.com',bucket:'test-bucket',prefix:'szjx/establishments/',accessKeyId:'test-id',accessKeySecret:'test-secret'},async(url,options)=>{
    urls.push(url);assert.match(options.headers.Authorization,/^OSS4-HMAC-SHA256 Credential=test-id\//);
    if(!url.includes('?'))return new Response(item.bytes);
    return new Response(url.includes('continuation-token=')?'<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>':`<ListBucketResult><Contents><Key>${item.key}</Key><Size>${item.bytes.length}</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>`);
  });
  assert.equal((await source.list()).length,1);assert.ok(urls[1].includes('continuation-token=next'));
  assert.deepEqual(await source.download(item.key),item.bytes);await assert.rejects(source.download('other/file.xlsx'),/目录/);
});
