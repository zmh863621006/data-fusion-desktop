import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdminServer } from '../app.mjs';
import { createCaptcha } from '../captcha.mjs';
import { createSecurity } from '../security.mjs';
import { password, captchaFactory, loginCaptcha } from './helpers.mjs';

const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
async function start(options={}) {
  const server=createAdminServer({dataPath:':memory:',privateKey,initialPassword:password,captchaFactory,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let token='';
  async function api(path,body,method=body===undefined?'GET':'POST',cookie=token,headers={}) {
    const res=await fetch(base+path,{method,headers:{'content-type':'application/json',cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0],retry:res.headers.get('retry-after')};
  }
  async function login(username='admin',secret=password) {
    const input=await loginCaptcha(base,{username,password:secret});
    const response=await api('/api/admin/login',input.body,'POST',input.token);
    if(response.status===200)token=response.cookie;
    return response;
  }
  return {api,login,base,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
async function fixture(t,options) {const f=await start(options);t.after(f.close);return f;}

test('captcha is a PNG with no answer in API; missing, expired, foreign and reused challenges fail',async t=>{
  let now=Date.now();const f=await fixture(t,{now:()=>now});
  const png=createCaptcha();assert.match(png.answer,/^[A-Z2-9]{5}$/);assert.equal(Buffer.from(png.image.split(',')[1],'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal((await f.api('/api/admin/login',{username:'admin',password})).body.code,'CAPTCHA_INVALID');
  const foreign=await loginCaptcha(f.base,{username:'admin',password});
  assert.equal((await f.api('/api/admin/login',foreign.body,'POST','')).body.code,'CAPTCHA_INVALID');
  const expired=await loginCaptcha(f.base,{username:'admin',password});now+=120001;
  assert.equal((await f.api('/api/admin/login',expired.body,'POST',expired.token)).body.code,'CAPTCHA_INVALID');
  const input=await loginCaptcha(f.base,{username:'admin',password});
  assert.equal((await f.api('/api/admin/login',input.body,'POST',input.token)).status,200);
  assert.equal((await f.api('/api/admin/login',input.body,'POST',input.token)).body.code,'CAPTCHA_INVALID');
  const challenge=await f.api('/api/admin/captcha');assert.equal('answer' in challenge.body,false);
});

test('five password failures lock for 15 minutes; CAPTCHA errors do not spend password attempts',async t=>{
  let now=Date.now();const f=await fixture(t,{now:()=>now});
  for(let i=0;i<3;i++)assert.equal((await f.api('/api/admin/login',{username:'admin',password})).status,400);
  for(let i=0;i<5;i++){
    const result=await f.login('admin','wrong');
    assert.equal(result.status,i===4?429:401);assert.equal(result.body.attemptsRemaining,4-i);
    if(i===4)assert.equal(result.retry,'900');
  }
  assert.equal((await f.login()).status,429);
  now+=15*60_000+1;assert.equal((await f.login()).status,200);
  assert.equal((await f.login('admin','wrong')).body.attemptsRemaining,4);
});

test('lockout persists across service restarts and expired counters recover',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fusion-security-'));
  const dataPath=join(directory,'admin.sqlite');let now=Date.now();let f;
  try {
    f=await start({dataPath,now:()=>now});
    for(let i=0;i<5;i++)await f.login('admin','wrong');
    await f.close();f=undefined;
    f=await start({dataPath,now:()=>now});assert.equal((await f.login()).status,429);
    now+=15*60_000+1;assert.equal((await f.login()).status,200);
  }finally{
    if(f)await f.close();
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.startsWith(join(tmpdir(),'fusion-security-')));
    await rm(directory,{recursive:true,force:true});
  }
});

test('IP spoofing is ignored; explicit trusted proxy uses one overwritten X-Real-IP header',()=>{
  const db=new DatabaseSync(':memory:');try{
    const request={socket:{remoteAddress:'127.0.0.1'},headers:{'x-real-ip':'203.0.113.8','x-forwarded-for':'198.51.100.9'}};
    assert.equal(createSecurity(db).ip(request),'127.0.0.1');
    const trusted=createSecurity(db,{trustedProxies:['127.0.0.1']});assert.equal(trusted.ip(request),'203.0.113.8');
    assert.throws(()=>trusted.ip({...request,headers:{'x-real-ip':'203.0.113.8, 10.0.0.1'}}),/代理/);
    assert.throws(()=>createSecurity(db,{trustedProxies:['*']}),/明确/);
  }finally{db.close();}
});

test('management allowlist protects pages and admin APIs without blocking desktop health',async t=>{
  const f=await fixture(t,{managementAllowedIps:['203.0.113.7'],trustedProxies:['127.0.0.1']});
  assert.equal((await f.api('/api/admin/captcha',undefined,'GET','',{'x-real-ip':'203.0.113.8'})).status,403);
  assert.equal((await f.api('/api/admin/captcha',undefined,'GET','',{'x-real-ip':'203.0.113.7'})).status,200);
  const page=await fetch(f.base,{headers:{'x-real-ip':'203.0.113.8'}});assert.equal(page.status,403);
  assert.equal((await f.api('/api/health')).status,200);
});

test('explicit public management allows any source while protected data still requires login',async t=>{
  const f=await fixture(t,{managementPublic:true,managementAllowedIps:['203.0.113.7'],trustedProxies:['127.0.0.1']});
  const headers={'x-real-ip':'198.51.100.9'};
  assert.equal((await fetch(f.base,{headers})).status,200);
  assert.equal((await f.api('/api/admin/captcha',undefined,'GET','',headers)).status,200);
  assert.equal((await f.api('/api/admin/bootstrap',undefined,'GET','',headers)).status,401);
  assert.equal((await f.api('/api/admin/customers',{name:'blocked'},'POST','',headers)).status,401);
});

test('operator cannot publish releases or maintain systems; admin must confirm password',async t=>{
  const f=await fixture(t);await f.login();
  await f.api('/api/admin/users',{username:'operator',password,role:'operator'});
  const release={version:'2.0.0',url:'https://example.invalid/app.exe',sha256:'a'.repeat(64)};
  assert.equal((await f.api('/api/admin/updates',release)).status,400);
  const created=await f.api('/api/admin/updates',{...release,confirmPassword:password});assert.equal(created.status,201);
  const bootstrap=await f.api('/api/admin/bootstrap'),id=bootstrap.body.updates[0].id;
  assert.equal((await f.api(`/api/admin/updates/${id}`,{enabled:false,confirmPassword:'bad'},'PATCH')).status,400);
  assert.equal((await f.api(`/api/admin/updates/${id}`,{enabled:false,confirmPassword:password},'PATCH')).status,200);
  await f.login('operator');assert.equal((await f.api('/api/admin/updates',{...release,confirmPassword:password})).status,403);
  assert.equal((await f.api(`/api/admin/updates/${id}`,{enabled:true,confirmPassword:password},'PATCH')).status,403);
  assert.equal((await f.api('/api/admin/systems/market-access',{enabled:false},'PATCH')).status,403);
});

test('signed device proof required for refresh and update; tampered proof and another device fail',async t=>{
  const f=await fixture(t);await f.login();
  const customer=(await f.api('/api/admin/customers',{name:'fixture'})).body.id;
  const issued=await f.api('/api/admin/licenses',{customerId:customer,mode:'online',expiresAt:Date.now()+600_000,allowedSystems:['market-access'],allowedMatters:{'market-access':['business-application-query']},allowAutoUpdate:true});
  const deviceId='a'.repeat(64),licenseId=issued.body.id;
  const proof=(await f.api('/api/activate',{key:issued.body.activationCode,deviceId})).body;
  const body={licenseId,deviceId,proof};
  assert.equal((await f.api('/api/license/status',{licenseId,deviceId})).body.code,'DEVICE_PROOF_REQUIRED');
  assert.equal((await f.api('/api/license/status',{...body,deviceId:'b'.repeat(64)})).status,403);
  assert.equal((await f.api('/api/license/status',{...body,proof:{...proof,signature:'tampered'}})).status,403);
  assert.equal((await f.api('/api/license/status',body)).status,200);
  assert.equal((await f.api('/api/updates/manifest')).status,403);
  assert.equal((await f.api('/api/updates/manifest',body)).status,200);
  const expiredPayload=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(proof.payload,'base64url')),expiresAt:Date.now()-1}));
  const expired={algorithm:'RSA-SHA256',payload:expiredPayload.toString('base64url'),signature:sign('RSA-SHA256',expiredPayload,privateKey).toString('base64url')};
  assert.equal((await f.api('/api/license/status',{...body,proof:expired})).status,200,'live renewed entitlement can refresh an expired proof');
  await f.api(`/api/admin/customers/${customer}`,{enabled:false},'PATCH');assert.equal((await f.api('/api/license/status',body)).status,403);
});

test('security logs redact secrets; sessions list and revoke only the current account',async t=>{
  const f=await fixture(t);const first=await f.login();await f.login('admin','wrong');await f.login();
  const sessions=(await f.api('/api/admin/sessions')).body;assert.equal(sessions.length,2);assert.equal(sessions.filter(row=>row.current).length,1);
  assert.equal('token_hash' in sessions[0],false);
  await f.api('/api/admin/sessions/revoke-others',{});
  assert.equal((await f.api('/api/admin/bootstrap',undefined,'GET',first.cookie)).status,401);
  assert.equal((await f.api('/api/admin/bootstrap')).status,200);
  const events=(await f.api('/api/admin/security-events')).body;
  assert.ok(events.rows.some(row=>row.event==='login.failed'));assert.equal(JSON.stringify(events).includes(password),false);
  await f.api('/api/admin/users',{username:'viewer',password,role:'viewer'});await f.login('viewer');
  assert.equal((await f.api('/api/admin/security-events')).status,403);
  assert.equal((await f.api('/api/admin/sessions/revoke-others',{})).status,200);
});

test('password policy and legacy upgrade are enforced; password change revokes every session',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'fusion-security-policy-'));const dataPath=join(directory,'admin.sqlite');let f;
  try{
    f=await start({dataPath});await f.close();f=undefined;
    const oldPassword='legacy-test-password',salt=randomBytes(16);
    const oldHash=`${salt.toString('base64url')}:${scryptSync(oldPassword,salt,32).toString('base64url')}`;
    const db=new DatabaseSync(dataPath);db.prepare('UPDATE admin_users SET password_policy_version=0,password_hash=?').run(oldHash);db.close();
    f=await start({dataPath});await f.login('admin',oldPassword);assert.equal((await f.api('/api/admin/bootstrap')).body.user.passwordChangeRequired,1);
    assert.equal((await f.api('/api/admin/customers',{name:'blocked'})).body.code,'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await f.api('/api/admin/password',{oldPassword,newPassword:'weak'})).status,400);
    assert.equal((await f.api('/api/admin/password',{oldPassword,newPassword:'Updated-Password-2026!'})).status,200);
    assert.equal((await f.api('/api/admin/bootstrap')).status,401);
    await f.login('admin','Updated-Password-2026!');assert.equal((await f.api('/api/admin/customers',{name:'allowed'})).status,201);
    const check=new DatabaseSync(dataPath);assert.ok(check.prepare('SELECT password_hash FROM admin_users').get().password_hash.startsWith('s2:'));
    check.prepare('UPDATE admin_sessions SET last_seen_at=?').run(Date.now()-31*60_000);check.close();
    assert.equal((await f.api('/api/admin/bootstrap')).status,401,'idle session expires');
  }finally{if(f)await f.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.startsWith(join(tmpdir(),'fusion-security-policy-')));await rm(directory,{recursive:true,force:true});}
});

test('public activation is rate limited and proxy headers cannot evade it',async t=>{
  const f=await fixture(t);
  for(let i=0;i<30;i++)assert.equal((await f.api('/api/activate',{deviceId:'invalid'},'POST','',{'x-real-ip':`203.0.113.${i+1}`})).status,400);
  const limited=await f.api('/api/activate',{deviceId:'invalid'});assert.equal(limited.status,429);assert.ok(Number(limited.retry)>0);
});

test('admin can view lock state and unlock an account; weak new passwords are rejected',async t=>{
  const f=await fixture(t);await f.login();
  assert.equal((await f.api('/api/admin/users',{username:'weak',password:'weak-password',role:'operator'})).status,400);
  const id=(await f.api('/api/admin/users',{username:'reader',password,role:'viewer'})).body.id;
  for(let i=0;i<5;i++)await f.login('reader','bad');
  const users=(await f.api('/api/admin/users')).body;assert.ok(users.find(row=>row.id===id).lockedForSeconds>0);
  assert.equal((await f.api(`/api/admin/users/${id}/unlock`,{})).status,200);
  assert.equal((await f.login('reader')).status,200);
});
