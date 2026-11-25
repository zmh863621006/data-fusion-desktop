import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// The entire test is synthetic. It has no preload, app credentials, production database or source requests.
const directory = resolve('.tmp/batch-return-ui-' + Date.now());
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'fixture.tsx'), `
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { BatchReturnPanel } from '../../src/renderer/src/BatchReturnPanel';
import '../../src/renderer/src/styles.css';
const dates=[{key:'startDate',label:'开始日期',type:'date',required:true},{key:'endDate',label:'结束日期',type:'date',required:true}];
const matter=(id,name,department,extras=[],defaults={})=>({id,name,departmentId:department,departmentName:department,executionMode:'one-click-return',querySchema:[...dates,...extras],defaultFilters:defaults});
const items=[matter('A','失业信息','就业服务',[],{unrelated:'A-only'}),matter('B','岗位补贴','街道办',[{key:'kind',label:'补贴类型',type:'select',required:true,options:[{label:'第一类',value:1},{label:'第二类',value:2}]}]),matter('C','创业补贴','街道办',[{key:'region',label:'办理地区',type:'text'},{key:'tags',label:'标签',type:'multi-select',options:[{label:'甲',value:'a'}]}],{region:'C-DEFAULT',tags:['a']}),matter('DENIED','未授权业务','隐藏部门'),{...matter('QUERY','普通查询','隐藏部门'),executionMode:'interactive-query'}];
window.fixture={submissions:[],created:[],release:null,mutate:()=>{items[2].defaultFilters.region='MUTATED';items[2].defaultFilters.tags.push('b')}};
function Fixture(){const[open,setOpen]=useState(false);return <><button id="fixture-open" onClick={()=>setOpen(true)}>打开批量回流</button>{open&&<BatchReturnPanel systemId="guangdong-hrss" systemName="人社隔离界面测试" matters={items} currentMatterId="A" startDate="2026-11-01" endDate="2026-11-25" canRun canSelectMatter={id=>id!=='DENIED'} onClose={()=>setOpen(false)} submit={async(systemId,payload)=>{window.fixture.submissions.push({systemId,payload});return new Promise(resolve=>{window.fixture.release=()=>resolve({batchId:'batch-synthetic',taskIds:['task-b','task-c'],count:2})})}} onCreated={result=>{window.fixture.created.push(result);setOpen(false)}}/>}</>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
await build({ entryPoints: [join(directory, 'fixture.tsx')], outfile: join(directory, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.svg': 'dataurl' } });
await writeFile(join(directory, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>');
await writeFile(join(directory, 'smoke.cjs'), `
const{app,BrowserWindow,session}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
app.setPath('userData',process.env.DATA_FUSION_BATCH_TEST_PROFILE);app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const root=${JSON.stringify(directory)};let window;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const evalJs=code=>window.webContents.executeJavaScript(code,true);
async function until(code){for(let i=0;i<150;i++){if(await evalJs(code))return;await sleep(20)}throw Error('UI condition not reached: '+code)}
async function setInput(selector,value){await evalJs('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()');await sleep(30)}
async function clickText(text){await evalJs('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==='+JSON.stringify(text)+').click()');await sleep(30)}
async function run(){await app.whenReady();let networkAttempts=0;const browser=session.fromPartition('batch-return-fixture',{cache:false});browser.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,cb)=>{networkAttempts++;cb({cancel:true})});window=new BrowserWindow({show:false,width:1024,height:768,webPreferences:{session:browser,sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadFile(root+'/index.html');await until('Boolean(document.querySelector("#fixture-open"))');
await evalJs('(()=>{const e=document.querySelector("#fixture-open");e.focus();e.click()})()');await until('Boolean(document.querySelector(".batch-return-panel"))');
assert.equal(await evalJs('document.querySelectorAll(".batch-return-choice").length'),3);assert.equal(await evalJs('document.body.innerText.includes("未授权业务")'),false);assert.equal(await evalJs('document.body.innerText.includes("普通查询")'),false);
window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await until('!document.querySelector(".batch-return-panel")');assert.equal(await evalJs('document.activeElement.id'),'fixture-open');await evalJs('(()=>{const e=document.querySelector("#fixture-open");e.focus();e.click()})()');await until('Boolean(document.querySelector(".batch-return-panel"))');
assert.deepEqual(await evalJs('[...document.querySelectorAll(".batch-return-dates input")].map(e=>e.value)'),['2026-11-01','2026-11-25']);
await setInput('.batch-return-search input','岗位');assert.equal(await evalJs('document.querySelectorAll(".batch-return-choice").length'),1);await clickText('全选当前系统');await setInput('.batch-return-search input','');assert.equal(await evalJs('document.querySelectorAll(".batch-return-choice input:checked").length'),3);
await clickText('清空');assert.equal(await evalJs('document.querySelector(".batch-return-footer .primary").disabled'),true);await setInput('.batch-return-search input','岗位');await evalJs('[...document.querySelectorAll(".batch-return-group")].find(e=>e.querySelector("h4").textContent==="街道办").querySelector("button").click()');await sleep(30);await setInput('.batch-return-search input','');assert.equal(await evalJs('document.querySelectorAll(".batch-return-choice input:checked").length'),2);
await clickText('开始回流（2项）');assert.equal(await evalJs('window.fixture.submissions.length'),0);assert.match(await evalJs('document.querySelector(".batch-return-error").innerText'),/岗位补贴.*补贴类型不能为空/);
await evalJs('(()=>{const e=document.querySelector(".batch-return-extra select");e.value="2";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await sleep(30);
await setInput('.batch-return-dates input:first-of-type','2026-12-01');await clickText('开始回流（2项）');assert.equal(await evalJs('window.fixture.submissions.length'),0);assert.match(await evalJs('document.querySelector(".batch-return-error").innerText'),/开始日期不能晚于结束日期/);
await evalJs('(()=>{const es=document.querySelectorAll(".batch-return-dates input");window.setFixtureDate=(index,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(es[index],value);es[index].dispatchEvent(new Event("input",{bubbles:true}));es[index].dispatchEvent(new Event("change",{bubbles:true}))};window.setFixtureDate(0,"2026-11-10")})()');await sleep(30);await evalJs('window.setFixtureDate(1,"2026-11-20")');await sleep(30);
for(const width of [1024,760]){window.setContentSize(width,700);await sleep(40);const layout=await evalJs('(()=>{const p=document.querySelector(".batch-return-panel").getBoundingClientRect(),f=document.querySelector(".batch-return-footer").getBoundingClientRect();return {panel:p.width,left:p.left,right:p.right,footerBottom:f.bottom,width:innerWidth,height:innerHeight}})()');assert(layout.left>=0&&layout.right<=layout.width&&layout.footerBottom<=layout.height);await fs.writeFile(root+'/drawer-'+width+'.png',(await window.webContents.capturePage()).toPNG())}
await evalJs('(()=>{const b=document.querySelector(".batch-return-footer .primary");b.click();b.click()})()');await until('window.fixture.submissions.length===1');assert.equal(await evalJs('document.querySelector(".batch-return-footer .primary").disabled'),true);await evalJs('window.fixture.mutate()');const sent=await evalJs('window.fixture.submissions[0]');assert.deepEqual(sent,{systemId:'guangdong-hrss',payload:{matterIds:['B','C'],startDate:'2026-11-10',endDate:'2026-11-20',filtersByMatter:{B:{kind:2},C:{region:'C-DEFAULT',tags:['a']}}}});
await evalJs('window.fixture.release()');await until('!document.querySelector(".batch-return-panel")');assert.equal(await evalJs('window.fixture.created.length'),1);assert.equal(networkAttempts,0);await fs.writeFile(root+'/verification.json',JSON.stringify({passed:true,networkAttempts,selectionScope:true,searchAndWholeSystemSelection:true,groupSelection:true,sharedDateSnapshot:true,extraConditions:true,duplicateClickBlocked:true,keyboardClose:true,widths:[1024,760]},null,2));console.log(JSON.stringify({passed:true,networkAttempts,evidence:root}));window.destroy();app.quit()}
run().catch(e=>{console.error(e);window?.destroy();app.exit(1)});
`);
const profile = await mkdtemp(join(tmpdir(), 'fusion-batch-ui-'));
try {
  const environment = { ...process.env, DATA_FUSION_BATCH_TEST_PROFILE: profile }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'smoke.cjs')], { env: environment, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90_000);
  try { process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)); }); }
  finally { clearTimeout(timer); }
} finally {
  const absolute = resolve(profile); assert.equal(dirname(absolute), resolve(tmpdir())); assert(basename(absolute).startsWith('fusion-batch-ui-'));
  await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
