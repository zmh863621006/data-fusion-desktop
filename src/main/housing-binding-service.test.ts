import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { NodeSqliteDriver } from '../core/storage/database';
import { TaskEngine } from '../core/tasks/engine';
import { AppError } from '../core/errors/app-error';
import { HousingBindingService } from './housing-binding-service';
import type { HousingBindingTarget } from '../plugins/shenzhen-housing-rental/types';
const code=(n:number)=>String(n).padStart(25,'0');
const target:HousingBindingTarget={acceptanceId:'acceptance-fixture',propertyId:'property-fixture',certificateNumber:'测试产权证',areaId:'440305001000000000',cardId:null};
let db:NodeSqliteDriver,tasks:TaskEngine,service:HousingBindingService;
const bound=new Set<string>();
const authorize=vi.fn(async()=>{}),session=vi.fn(async()=>({status:'authenticated'}));
const client={
 resolveTarget:vi.fn(async()=>({...target})),
 findHouse:vi.fn(async(value:string)=>({id:value,code:value,buildingId:'building-fixture',address:'测试房屋',areaId:target.areaId})),
 isBound:vi.fn(async(_target:HousingBindingTarget,house:{id:string})=>bound.has(house.id)),
 bindHouse:vi.fn(async(_target:HousingBindingTarget,house:{id:string},_signal?:AbortSignal)=>{bound.add(house.id)}),
};
async function workbook(values:string[]){const w=new ExcelJS.Workbook(),s=w.addWorksheet('编码');s.addRow(['房屋编码']);values.forEach(v=>s.addRow([v]));return Buffer.from(await w.xlsx.writeBuffer())}
async function upload(values:string[]){return service.importWorkbook(await workbook(values),'房屋.xlsx')}
async function create(values:string[],acceptanceNumber='测试受理编号'){const p=await upload(values);return service.create({acceptanceNumber,certificateNumber:target.certificateNumber,importId:p.importId})}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<1000;i++){if(await check())return;await new Promise(done=>setTimeout(done,2))}throw Error('fixture did not settle')}
async function idle(){await until(()=>tasks.list().every(task=>!['queued','running'].includes(task.status)))}
beforeEach(async()=>{
 vi.clearAllMocks();bound.clear();authorize.mockResolvedValue();session.mockResolvedValue({status:'authenticated'});
 client.resolveTarget.mockImplementation(async()=>({...target}));
 client.findHouse.mockImplementation(async value=>({id:value,code:value,buildingId:'building-fixture',address:'测试房屋',areaId:target.areaId}));
 client.isBound.mockImplementation(async(_t,h)=>bound.has(h.id));client.bindHouse.mockImplementation(async(_t,h)=>{bound.add(h.id)});
 db=new NodeSqliteDriver(':memory:');tasks=new TaskEngine(undefined,2);
 service=new HousingBindingService({database:db,tasks,client,authorize,session});await service.initialize();
});
afterEach(async()=>{await service.stop();await db.close()});

it('binds serially, skips existing relations, keeps missing rows, and confirms uncertain writes before any retry',async()=>{
 bound.add(code(1));
 client.findHouse.mockImplementation(async value=>value===code(2)?null as never:{id:value,code:value,buildingId:'building-fixture',address:'测试房屋',areaId:target.areaId});
 client.bindHouse.mockImplementation(async(_t,h)=>{if(h.id===code(4)){bound.add(h.id);throw new AppError('REMOTE_TIMEOUT','超时')}if(h.id===code(5))throw new AppError('REMOTE_TIMEOUT','超时');bound.add(h.id)});
 const job=await create([code(1),code(2),code(3),code(4),code(5)]);await idle();
 const result=await service.detail(job.id);
 expect(result.job).toMatchObject({phase:'failed',succeeded:2,skipped:1,failed:2,pending:0});
 expect(result.rows.map(row=>row.status)).toEqual(['already-bound','failed','succeeded','succeeded','unknown']);
 expect(client.bindHouse).toHaveBeenCalledTimes(3);
 // A previously uncertain request completed later. A manual retry must read first and never repeat it.
 bound.add(code(5));client.findHouse.mockImplementation(async value=>({id:value,code:value,buildingId:'building-fixture',address:'测试房屋',areaId:target.areaId}));
 const retry=await service.retry(job.id);await idle();
 expect((await service.detail(retry.id)).job).toMatchObject({total:2,succeeded:2,skipped:0,parentJobId:job.id,phase:'completed'});
 expect(client.bindHouse).toHaveBeenCalledTimes(4);
 expect((await service.detail(job.id)).rows.map(row=>row.status)).toEqual(result.rows.map(row=>row.status));
});

it('rejects duplicate active submissions and serializes housing tasks across different cases',async()=>{
 let release!:()=>void;const blocker=new Promise<void>(done=>release=done);let first=true;
 client.bindHouse.mockImplementation(async(_t,h)=>{if(first){first=false;await blocker}bound.add(h.id)});
 const a=await create([code(1)]);await until(()=>client.bindHouse.mock.calls.length===1);
 const duplicate=await upload([code(1)]);
 await expect(service.create({acceptanceNumber:'测试受理编号',certificateNumber:target.certificateNumber,importId:duplicate.importId})).rejects.toThrow('未完成');
 const b=await create([code(2)],'另一受理编号');
 expect((await service.detail(b.id)).job.phase).toBe('queued');expect(client.resolveTarget).toHaveBeenCalledTimes(1);
 release();await idle();expect((await service.detail(a.id)).job.phase).toBe('completed');expect((await service.detail(b.id)).job.phase).toBe('completed');
});

it('waits for an actual login event, resolves fresh context, then reads back a write interrupted by auth expiry',async()=>{
 client.bindHouse.mockImplementationOnce(async(_t,h)=>{bound.add(h.id);throw new AppError('SESSION_EXPIRED','会话过期')});
 const job=await create([code(1)]);await until(async()=>(await service.detail(job.id)).job.phase==='waiting-login');
 expect(client.bindHouse).toHaveBeenCalledTimes(1);expect(client.resolveTarget).toHaveBeenCalledTimes(1);
 service.setAuthenticated(true);await idle();
 expect(client.resolveTarget).toHaveBeenCalledTimes(2);expect(client.bindHouse).toHaveBeenCalledTimes(1);
 expect((await service.detail(job.id)).rows[0]).toMatchObject({status:'succeeded'});
});

it('stops a resumed task if the original case property relation has changed',async()=>{
 client.bindHouse.mockRejectedValueOnce(new AppError('SESSION_EXPIRED','会话过期'));
 const job=await create([code(1)]);await until(async()=>(await service.detail(job.id)).job.phase==='waiting-login');
 client.resolveTarget.mockResolvedValue({...target,propertyId:'changed-property'});service.setAuthenticated(true);await idle();
 expect((await service.detail(job.id)).job).toMatchObject({phase:'failed',error:expect.stringContaining('关联已变化')});
 expect(client.bindHouse).toHaveBeenCalledTimes(1);
});

it('cancels an in-flight write as unknown and leaves later rows pending',async()=>{
 client.bindHouse.mockImplementationOnce(async(_t,_h,signal)=>new Promise<void>((_done,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));
 const job=await create([code(1),code(2)]);await until(()=>client.bindHouse.mock.calls.length===1);
 const cancelled=await service.cancel(job.id);expect(cancelled.phase).toBe('cancelled');
 expect((await service.detail(job.id)).rows.map(row=>row.status)).toEqual(['unknown','pending']);expect(client.bindHouse).toHaveBeenCalledTimes(1);
});

it('recovers durable row state without silently rerunning interrupted jobs',async()=>{
 await db.run("INSERT INTO housing_binding_jobs(id,acceptance_number,certificate_number,file_name,phase,created_at,updated_at) VALUES('interrupted','case','cert','file.xlsx','running',1,1)");
 await db.run("INSERT INTO housing_binding_rows(job_id,row_number,code,status,message,updated_at) VALUES('interrupted',2,?,'binding','',1)",[code(1)]);
 await db.run("INSERT INTO housing_binding_rows(job_id,row_number,code,status,message,updated_at) VALUES('interrupted',3,?,'pending','',1)",[code(2)]);
 await service.initialize();const detail=await service.detail('interrupted');
 expect(detail.job.phase).toBe('interrupted');expect(detail.rows.map(row=>row.status)).toEqual(['unknown','pending']);expect(client.bindHouse).not.toHaveBeenCalled();
});

it('checks current matter authorization and rejects invalid import rows before creating any remote work',async()=>{
 authorize.mockRejectedValueOnce(new AppError('LICENSE_INVALID','未授权'));
 await expect(service.importWorkbook(Buffer.alloc(0),'invalid.xlsx')).rejects.toThrow('未授权');
 const p=await service.importWorkbook(await workbook(['12#34']),'invalid.xlsx');
 await expect(service.create({acceptanceNumber:'case',certificateNumber:'cert',importId:p.importId})).rejects.toThrow('错误行');
 expect(tasks.list()).toHaveLength(0);expect(client.resolveTarget).not.toHaveBeenCalled();
});
