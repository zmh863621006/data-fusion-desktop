import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { planLegacyEnterpriseImport, applyLegacyEnterpriseImport } from './enterprise-import.mjs';
import { createOssEstablishmentSource } from './oss-establishment-source.mjs';

const HEADERS=['源记录ID','网上申请号','主体名称','事项名称','统一社会信用代码','法定代表人姓名','注册地址','受理时间','审批状态','详情JSON'];
export const ESTABLISHMENT_SOURCE='szjx-establishment';
const text = cell => { if (typeof cell.value !== 'string' && cell.value !== null) throw Error('设立工作簿包含非文本单元格'); return cell.value ?? ''; };
export async function parseEstablishmentWorkbook(bytes) {
  if (bytes.length > 64*1024*1024) throw Error('设立文件超过64MiB限制');
  const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
  const meta=workbook.getWorksheet('Metadata'), sheet=workbook.getWorksheet('Records');
  if (!meta || !sheet) throw Error('设立工作簿缺少 Metadata 或 Records');
  const metadata=Object.fromEntries(meta.getRows(1,meta.rowCount).map(row=>[text(row.getCell(1)),text(row.getCell(2))]));
  if (metadata.schemaVersion!=='szjx-establishments-v1' || metadata.scope!=='shenzhen-establishment' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(metadata.collectedAt ?? '')) throw Error('设立文件版本或采集范围不匹配');
  if (Number(metadata.recordCount)!==sheet.rowCount-1 || sheet.rowCount>100001) throw Error('设立文件记录数不匹配或超限');
  HEADERS.forEach((name,i)=>{if(text(sheet.getRow(1).getCell(i+1))!==name)throw Error('设立工作簿表头不匹配')});
  const rows=[], ids=new Set();
  for(let i=2;i<=sheet.rowCount;i++) {
    const cells=sheet.getRow(i); const values=HEADERS.map((_,n)=>text(cells.getCell(n+1)));
    let payload=values[9];
    for(let col=11;col<=cells.cellCount;col++) { if(text(sheet.getRow(1).getCell(col))!==`详情JSON续${col-10}`)throw Error('设立详情续列不匹配'); payload+=text(cells.getCell(col)); }
    const detail=JSON.parse(payload);
    if (!values[0] || values[0].length>128 || ids.has(values[0]) || detail.DATA_ID!==values[0] || detail.APPLY_PARTY_NAME!==values[2] || detail.INFOFLOW_NAME!==values[3]) throw Error('设立记录标识缺失、重复或明细不匹配');
    if (!/(设立|开业)/.test(values[3]) || /(变更|注销|撤销|备案|补发|换发|迁入|迁出)/.test(values[3])) throw Error('设立文件包含其他业务类型');
    ids.add(values[0]); rows.push({sourceId:values[0],applyNo:values[1],name:values[2],matter:values[3],creditCode:values[4],legalPerson:values[5],address:values[6],acceptedAt:values[7],status:values[8],payload,observedAt:metadata.collectedAt});
  }
  return rows;
}

export function createEstablishmentImporter(db,{source,onError=()=>{}}) {
  db.exec(`CREATE TABLE IF NOT EXISTS establishment_batches(object_key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,row_count INTEGER NOT NULL,imported_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS establishment_records(source_id TEXT PRIMARY KEY,apply_no TEXT NOT NULL,name TEXT NOT NULL,matter TEXT NOT NULL,credit_code TEXT NOT NULL,legal_person TEXT NOT NULL,address TEXT NOT NULL,accepted_at TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL,observed_at TEXT NOT NULL,object_key TEXT NOT NULL);`);
  let running=false,closed=false,job=null,inflight=Promise.resolve();
  async function poll() {
    if (running || closed) return; running=true;
    try {
      for(const {key} of await source.list()) {
        if(closed)break;
        if(db.prepare('SELECT 1 FROM establishment_batches WHERE object_key=?').get(key))continue;
        try {
          const bytes=await source.download(key); if(closed)break;
          const sha=createHash('sha256').update(bytes).digest('hex');
          if(!key.endsWith(`_${sha}.xlsx`))throw Error('设立文件 SHA-256 不匹配');
          const rows=await parseEstablishmentWorkbook(bytes); if(closed)break;
          // Never let an older backlogged object overwrite more recent observations.
          const fresh=rows.filter(row=>{const old=db.prepare('SELECT observed_at FROM establishment_records WHERE source_id=?').get(row.sourceId);return !old || old.observed_at<=row.observedAt});
          const enterprises=fresh.map(row=>({sourceId:row.sourceId,sourceTable:ESTABLISHMENT_SOURCE,sourceSavedAt:row.acceptedAt,sourceObservedAt:row.observedAt,sourceQuery:row.matter,name:row.name,creditCode:row.creditCode,legalPerson:row.legalPerson}));
          const options={source:ESTABLISHMENT_SOURCE,actor:'service:oss-establishment'};
          const plan=planLegacyEnterpriseImport(db,enterprises,options);
          applyLegacyEnterpriseImport(db,enterprises,plan.digest,options);
          // Enterprise import is idempotent; a crash before this receipt safely retries it.
          db.exec('BEGIN IMMEDIATE');
          try {
            for(const row of fresh)db.prepare(`INSERT INTO establishment_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET apply_no=excluded.apply_no,name=excluded.name,matter=excluded.matter,credit_code=excluded.credit_code,legal_person=excluded.legal_person,address=excluded.address,accepted_at=excluded.accepted_at,status=excluded.status,payload_json=excluded.payload_json,observed_at=excluded.observed_at,object_key=excluded.object_key`)
              .run(row.sourceId,row.applyNo,row.name,row.matter,row.creditCode,row.legalPerson,row.address,row.acceptedAt,row.status,row.payload,row.observedAt,key);
            db.prepare('INSERT INTO establishment_batches VALUES(?,?,?,?)').run(key,sha,rows.length,Date.now());db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error}
        }catch{onError('设立文件解析或导入失败，将保留并重试')}
      }
    }catch{onError('OSS 设立文件读取失败，将自动重试')}
    finally{running=false}
  }
  return {
    poll(){inflight=poll();return inflight},
    start(interval=300000){if(job)return;job=setInterval(()=>{inflight=poll()},interval);job.unref();inflight=poll()},
    async close(){closed=true;clearInterval(job);await inflight},
  };
}

export function establishmentImporterFromEnv(db,env=process.env,onError=console.error) {
  if(env.ESTABLISHMENT_OSS_ENABLED!=='true')return null;
  const source=createOssEstablishmentSource({endpoint:env.ESTABLISHMENT_OSS_ENDPOINT,bucket:env.ESTABLISHMENT_OSS_BUCKET,prefix:env.ESTABLISHMENT_OSS_PREFIX??'szjx/establishments/',accessKeyId:env.ESTABLISHMENT_OSS_ACCESS_KEY_ID,accessKeySecret:env.ESTABLISHMENT_OSS_ACCESS_KEY_SECRET,securityToken:env.ESTABLISHMENT_OSS_SECURITY_TOKEN});
  return createEstablishmentImporter(db,{source,onError});
}
