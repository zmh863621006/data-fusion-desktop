import { describe, it, expect, vi } from 'vitest';
import { applyEnterpriseResult, enterpriseInput, EnterpriseEnrichmentService, mergeEnterpriseRecord, type EnterpriseResult } from './service';
import { applyFixedDrainagePermitContent, NEW_DRAINAGE_PERMIT_CONTENT, NEW_DRAINAGE_PERMIT_MATTER } from '../../plugins/government-info/field-rules';

const code = '91440300123456789Q';
const result: EnterpriseResult = { requestId: 'request', status: 'success', reason: '', enterprise: {
  id:'enterprise',name:'标准公司',creditCode:code,legalPerson:'测试法人',source:'aliyun-code',updatedAt:10,
} };
describe('enterprise enrichment',()=>{
  it('does not extend a backend cooldown when rows keep arriving and retries after the original deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => Response.json({ results: [result] }));
    const service = new EnterpriseEnrichmentService('https://backend.test/resolve', async () => ({ proof: { payload: 'x', signature: 'x', algorithm: 'RSA-SHA256' }, deviceId: 'a' }), fetcher);
    const row = { qymc: '标准公司', cardNumber: code };
    try {
      await service.enrich('government-info', 'matter', [row]);
      for (const at of [110_000, 120_000, 129_999]) {
        clock.mockReturnValue(at);
        expect((await service.enrich('government-info', 'matter', [row]))[0].frdb).toBeUndefined();
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(130_000);
      expect((await service.enrich('government-info', 'matter', [row]))[0].frdb).toBe('测试法人');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); warning.mockRestore(); }
  });
  it('can enrich immediately after local authorization becomes available', async () => {
    const auth = { proof: { payload: 'x', signature: 'x', algorithm: 'RSA-SHA256' as const }, deviceId: 'a' };
    const authorization = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(auth);
    const fetcher = vi.fn(async () => Response.json({ results: [result] }));
    const service = new EnterpriseEnrichmentService('https://backend.test/resolve', authorization, fetcher);
    const row = { qymc: '标准公司', cardNumber: code };
    await service.enrich('government-info', 'matter', [row]);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await service.enrich('government-info', 'matter', [row]))[0].frdb).toBe('测试法人');
  });
  it('uses the verified canonical enterprise name in the new-drainage content and cached reruns', () => {
    const row = applyFixedDrainagePermitContent({ cityLsh: '1', sxmc: NEW_DRAINAGE_PERMIT_MATTER,
      qymc: '错字公司', applyer: '错字公司', cardNumber: code });
    const next = applyEnterpriseResult('government-info', row, enterpriseInput('government-info', row)!, result);
    expect(next).toMatchObject({ qymc: '标准公司', xkXdrMc: '标准公司', applyer: '错字公司',
      xknr: `标准公司：${NEW_DRAINAGE_PERMIT_CONTENT}`, xkNr: `标准公司：${NEW_DRAINAGE_PERMIT_CONTENT}` });
    expect(mergeEnterpriseRecord('government-info', row, next)).toMatchObject({
      xknr: `标准公司：${NEW_DRAINAGE_PERMIT_CONTENT}`, xkNr: `标准公司：${NEW_DRAINAGE_PERMIT_CONTENT}`,
    });
  });
  it('uses an existing valid oversize code even when older partial enrichment originally queried by name', () => {
    const row = { xkXdrMc: '标准公司', xkXdrLb: '法人及非法人组织', xkXdrShxym: '', xkFrdb: '' };
    const input = enterpriseInput('oversize-transport', row)!;
    const next = applyEnterpriseResult('oversize-transport', row, input, { ...result, status: 'partial', enterprise: { ...result.enterprise!, legalPerson: '' } });
    expect(enterpriseInput('oversize-transport', next)).toEqual({ name: '标准公司', creditCode: code, applicantCode: '' });
    expect(enterpriseInput('online-car-permit', next)).toEqual(input);
  });
  it('classifies oversize enterprises by the enriched code and skips subsequent complete records', () => {
    const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
    const prefix = '92440300123456789';
    const sum = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28].reduce((total, weight, i) => total + alphabet.indexOf(prefix[i]) * weight, 0);
    const individualCode = prefix + alphabet[(31 - sum % 31) % 31];
    const row = { xkXdrMc: '运输经营部', xkXdrLb: '法人及非法人组织', xkXdrShxym: '', xkFrdb: '' };
    const input = enterpriseInput('oversize-transport', row)!;
    const individual = { ...result, enterprise: { ...result.enterprise!, name: '运输经营部', creditCode: individualCode } };
    const next = applyEnterpriseResult('oversize-transport', row, input, individual);
    expect(next).toMatchObject({ xkXdrLb: '个体工商户', xkXdrShxym: individualCode, xkFrdb: '测试法人' });
    expect(enterpriseInput('oversize-transport', next)).toBeNull();
    expect(applyEnterpriseResult('oversize-transport', next, input, individual)).toEqual(next);
  });
  it('uses name first identity with applicant code fallback; skips natural persons and unrelated systems',()=>{
    expect(enterpriseInput('government-info',{applyer:'错误公司',cardNumber:code})).toEqual({name:'错误公司',creditCode:'',applicantCode:code});
    expect(enterpriseInput('government-info',{applyer:'张三',cardNumber:'440305199001011234'})).toBeNull();
    expect(enterpriseInput('online-car-permit',{xkXdrMc:'张三',xkXdrLb:'自然人'})).toBeNull();
    expect(enterpriseInput('market-access',{qymc:'公司'})).toBeNull();
  });
  it('keeps raw applicant name, corrects canonical name and fills lawyer/code with audit evidence',()=>{
    const row={cityLsh:'1',sxmc:'事项',applyer:'错误公司',cardNumber:code,xkbh:'证号',xknr:'内容',ajmc:'案件',xkjdrq:'2026-01-01',yxqs:'2026-01-01'};
    const input=enterpriseInput('government-info',row)!;
    const next=applyEnterpriseResult('government-info',row,input,result);
    expect(next).toMatchObject({applyer:'错误公司',qymc:'标准公司',frdb:'测试法人',xydm:code,fillStatus:'1'});
    expect(next.enterpriseEnrichment).toMatchObject({input,before:{frdb:''},applied:{frdb:'测试法人'}});
    expect(applyEnterpriseResult('government-info',next,input,result)).toEqual(next);
    expect(enterpriseInput('government-info',next)).toBeNull();
  });
  it('never overwrites an existing manual legal person or mismatched credit code',()=>{
    const row={xkXdrMc:'错误公司',xkXdrLb:'法人及非法人组织',xkXdrShxym:code,xkFrdb:'人工法人'};
    const input={name:'错误公司',creditCode:code,applicantCode:''};
    const next=applyEnterpriseResult('online-car-permit',row,input,result);
    expect(next.xkFrdb).toBe('人工法人'); expect(next.enterpriseEnrichment).toMatchObject({status:'review'});
    const conflict={...row,xkXdrShxym:'91440300987654321R'};
    expect(applyEnterpriseResult('online-car-permit',conflict,{...input,creditCode:conflict.xkXdrShxym},result)).toMatchObject({xkXdrMc:'错误公司',xkXdrShxym:conflict.xkXdrShxym});
  });
  it('updates earlier managed values but preserves subsequent manual edits',()=>{
    const row={xkXdrMc:'错误公司',xkXdrLb:'法人及非法人组织',xkXdrShxym:code}; const input=enterpriseInput('oversize-transport',row)!;
    const first=applyEnterpriseResult('oversize-transport',row,input,result);
    const updated={...result,enterprise:{...result.enterprise!,legalPerson:'新法人',updatedAt:20}};
    expect(applyEnterpriseResult('oversize-transport',first,input,updated).xkFrdb).toBe('新法人');
    expect(applyEnterpriseResult('oversize-transport',{...first,xkFrdb:'人工编辑'},input,updated).xkFrdb).toBe('人工编辑');
  });
  it('reuses confirmed name aliases without a code and preserves offline enrichment on rerun',()=>{
    const row={qymc:'错字公司',applyer:'错字公司',cityLsh:'1',sxmc:'事项'};
    const input=enterpriseInput('government-info',row)!;
    const enriched=applyEnterpriseResult('government-info',row,input,result);
    expect(enriched.qymc).toBe('标准公司');
    expect(mergeEnterpriseRecord('government-info',row,enriched)).toMatchObject({qymc:'标准公司',frdb:'测试法人'});
    expect(mergeEnterpriseRecord('government-info',row,{...enriched,frdb:'人工法人'}).frdb).toBe('人工法人');
    const manual=mergeEnterpriseRecord('government-info',row,{...enriched,frdb:'人工法人'});
    expect(mergeEnterpriseRecord('government-info',row,manual)).toMatchObject({qymc:'标准公司',xydm:code,frdb:'人工法人'});
    expect(mergeEnterpriseRecord('government-info',{...row,qymc:'不同企业'},enriched).frdb).toBeUndefined();
  });
  it('batches/deduplicates cache requests, refreshes across authorization and preserves rows on failure',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({results:[result]})));
    let signature='fixture';
    const service=new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve',async()=>({proof:{payload:'x',signature,algorithm:'RSA-SHA256'},deviceId:'a'}),fetcher);
    const row={qymc:'错误公司',cardNumber:code};
    expect((await service.enrich('government-info','matter',[row,row]))[0].frdb).toBe('测试法人');
    expect(fetcher).toHaveBeenCalledTimes(1); await service.enrich('government-info','matter',[row]); expect(fetcher).toHaveBeenCalledTimes(1);
    signature='new';fetcher.mockResolvedValueOnce(new Response('',{status:503}));
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    expect((await service.enrich('government-info','matter',[row]))[0]).toMatchObject({...row,enterpriseEnrichment:{status:'error'}}); expect(fetcher).toHaveBeenCalledTimes(2);warn.mockRestore();
  });
  it('requires explicit consent for the exact remote HTTP origin',async()=>{
    const row={qymc:'错误公司',cardNumber:code};
    const fetcher=vi.fn(async()=>Response.json({results:[result]}));
    const authorization=async()=>({proof:{payload:'x',signature:'x',algorithm:'RSA-SHA256' as const},deviceId:'a'});
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const blocked=new EnterpriseEnrichmentService('http://backend.test:9087/api/enterprises/resolve',authorization,fetcher);
      expect((await blocked.enrich('government-info','matter',[row]))[0]).toMatchObject({...row,enterpriseEnrichment:{status:'error'}});expect(fetcher).not.toHaveBeenCalled();
      const allowed=new EnterpriseEnrichmentService('http://backend.test:9087/api/enterprises/resolve',authorization,fetcher,'http://backend.test:9087');
      expect((await allowed.enrich('government-info','matter',[row]))[0].frdb).toBe('测试法人');expect(fetcher).toHaveBeenCalledTimes(1);
      const foreign=new EnterpriseEnrichmentService('http://other.test:9087/api/enterprises/resolve',authorization,fetcher,'http://backend.test:9087');
      expect((await foreign.enrich('government-info','matter',[row]))[0]).toMatchObject({...row,enterpriseEnrichment:{status:'error'}});expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {warning.mockRestore();}
  });
  it('never even authorizes or contacts the backend when source legal person and valid code are complete', async () => {
    const authorization=vi.fn(), fetcher=vi.fn();
    const service=new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve',authorization,fetcher);
    for (const system of ['oversize-transport','online-car-permit','government-info','health-publicity']) {
      const row={xkXdrMc:'原系统公司',xkXdrLb:'法人及非法人组织',xkFrdb:'原系统法人',xkXdrShxym:code};
      expect(enterpriseInput(system,row)).toBeNull();
      expect(await service.enrich(system,'matter',[row])).toEqual([row]);
    }
    const raw={qymc:'原公司',qylx:'法人及非法人组织',frdb:'手填法人',xydm:code};
    expect(await service.enrich('government-info','matter',[raw])).toEqual([raw]);
    const numeric={xkXdrMc:'原公司',xkXdrLb:'法人及非法人组织',xkFrdb:'原法人',xkXdrShxym:'914403000000000061'};
    expect(enterpriseInput('online-car-permit',numeric)).toBeNull();
    expect(authorization).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
  });
  it('fills canonical government rows and synchronizes raw semantic fields without modifying the original applicant', () => {
    const row={xkXdrMc:'错误公司',xkXdrLb:'法人及非法人组织',xkXdrShxym:'',xkFrdb:'',applyer:'原始申请人',cardNumber:code};
    const input=enterpriseInput('government-info',row)!;
    expect(input).toEqual({name:'错误公司',creditCode:'',applicantCode:code});
    expect(applyEnterpriseResult('government-info',row,input,result)).toMatchObject({
      qymc:'标准公司',xkXdrMc:'标准公司',xydm:code,xkXdrShxym:code,frdb:'测试法人',xkFrdb:'测试法人',applyer:'原始申请人',
    });
  });
  it('only fills missing source fields, preserves manual legal person, and supports health institutions and sole traders', async () => {
    const auth=async()=>({proof:{payload:'x',signature:'fixture',algorithm:'RSA-SHA256' as const},deviceId:'a'});
    const fetcher=vi.fn(async (_url,init) => {
      const items=JSON.parse(String(init?.body)).items as {name:string}[];
      return Response.json({results:items.map(item=>({...result,enterprise:{...result.enterprise!,name:item.name}}))});
    });
    const service=new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve',auth,fetcher);
    for (const category of ['法人及非法人组织','个体工商户']) {
      const row={xkXdrMc:'门诊部',xkXdrLb:category,xkFrdb:'手填法人',xkXdrShxym:''};
      expect((await service.enrich('health-publicity','word-to-publicity',[row]))[0]).toMatchObject({xkXdrMc:'门诊部',xkFrdb:'手填法人',xkXdrShxym:code,enterpriseEnrichment:{status:'review'}});
    }
    expect(enterpriseInput('health-publicity',{xkXdrMc:'张三',xkXdrLb:'自然人'})).toBeNull();
    const manual={xkXdrMc:'手填公司',xkXdrLb:'法人及非法人组织',xkFrdb:'',xkXdrShxym:code};
    expect(applyEnterpriseResult('online-car-permit',manual,enterpriseInput('online-car-permit',manual)!,result)).toMatchObject({xkXdrMc:'手填公司',xkFrdb:'测试法人',xkXdrShxym:code});
  });
  it('retains successful batches and explicit failure evidence when a later cloud batch is unavailable', async () => {
    const rows=Array.from({length:9},(_,i)=>({xkXdrMc:`企业${i}`,xkXdrLb:'法人及非法人组织',xkXdrShxym:code,xkFrdb:''}));
    const fetcher=vi.fn().mockImplementationOnce(async(_url,init)=>Response.json({results:JSON.parse(String(init.body)).items.map((item:{name:string})=>({...result,enterprise:{...result.enterprise!,name:item.name}}))}))
      .mockResolvedValueOnce(new Response('',{status:503}));
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const service=new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve',async()=>({proof:{payload:'x',signature:'x',algorithm:'RSA-SHA256'},deviceId:'a'}),fetcher);
      const next=await service.enrich('online-car-permit','online-car-permit-return',rows);
      expect(next.slice(0,4).every(row=>row.xkFrdb==='测试法人')).toBe(true);
      expect(next.slice(4).every(row=>row.xkFrdb==='' && (row.enterpriseEnrichment as {status:string}).status==='error')).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {warning.mockRestore();}
  });
  it('processes a 90-company return in bounded batches, deduplicates repeats, and awaits completion', async () => {
    const rows=Array.from({length:90},(_,i)=>({xkXdrMc:`企业${i}`,xkXdrLb:'法人及非法人组织',xkXdrShxym:code,xkFrdb:''}));
    const fetcher=vi.fn(async(_url,init)=> {
      const items=JSON.parse(String(init?.body)).items as {name:string}[];
      expect(items.length).toBeLessThanOrEqual(4);
      return Response.json({results:items.map(item=>({...result,enterprise:{...result.enterprise!,name:item.name}}))});
    });
    const service=new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve',async()=>({proof:{payload:'x',signature:'x',algorithm:'RSA-SHA256'},deviceId:'a'}),fetcher);
    const next=await service.enrich('oversize-transport','oversize-transport-return',[...rows,...rows]);
    expect(next).toHaveLength(180);expect(next.every(row=>row.xkFrdb==='测试法人')).toBe(true);expect(fetcher).toHaveBeenCalledTimes(23);
    expect(await service.enrich('oversize-transport','oversize-transport-return',next)).toEqual(next);expect(fetcher).toHaveBeenCalledTimes(23);
  });
  it('deduplicates simultaneous enrichment calls while a backend request is in flight', async () => {
    let finish!:(value:Response)=>void;
    const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));
    const service=new EnterpriseEnrichmentService('https://backend.test/api/enterprises/resolve',async()=>({proof:{payload:'x',signature:'x',algorithm:'RSA-SHA256'},deviceId:'a'}),fetcher);
    const row={xkXdrMc:'标准公司',xkXdrLb:'法人及非法人组织',xkXdrShxym:code};
    const first=service.enrich('online-car-permit','matter',[row]), second=service.enrich('online-car-permit','matter',[row]);
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));finish(Response.json({results:[result]}));
    expect((await first)[0].xkFrdb).toBe('测试法人');expect((await second)[0].xkFrdb).toBe('测试法人');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('re-queries an edited identity after a failed lookup rather than pinning an empty applied-fields snapshot', () => {
    const row={qymc:'旧公司',cardNumber:code};
    const failed=applyEnterpriseResult('government-info',row,enterpriseInput('government-info',row)!,{requestId:'failed',status:'not_found',reason:'未查到',enterprise:null});
    expect(enterpriseInput('government-info',{...failed,qymc:'新公司'})).toEqual({name:'新公司',creditCode:'',applicantCode:code});
    expect(enterpriseInput('government-info',{...failed,cardNumber:''})).toEqual({name:'旧公司',creditCode:'',applicantCode:''});
  });
});
