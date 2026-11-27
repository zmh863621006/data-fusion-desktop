import { beforeEach, describe, expect, it, vi } from 'vitest';
const f=vi.hoisted(()=>({handlers:new Map<string,(...args:any[])=>Promise<unknown>>(),service:vi.fn(),open:vi.fn(),read:vi.fn(),stat:vi.fn(),importWorkbook:vi.fn(),create:vi.fn(),state:vi.fn(),detail:vi.fn(),cancel:vi.fn(),retry:vi.fn(),template:vi.fn(),folder:vi.fn()}));
vi.mock('electron',()=>({BrowserWindow:class{},ipcMain:{handle:(name:string,fn:(...args:any[])=>Promise<unknown>)=>f.handlers.set(name,fn)},dialog:{showOpenDialog:f.open}}));
vi.mock('node:fs/promises',()=>({readFile:f.read,stat:f.stat}));
vi.mock('./runtime',()=>({appRuntime:{housingBinding:f.service,housingBindingTemplate:f.template,housingTemplateFolder:f.folder}}));
import {registerIpcHandlers}from'./ipc';import{IPC_CHANNELS as C}from'../core/ipc/channels';
const frame={},event={sender:{id:7,mainFrame:frame},senderFrame:frame};
describe('housing task IPC',()=>{
 beforeEach(()=>{vi.clearAllMocks();f.handlers.clear();f.service.mockResolvedValue({importWorkbook:f.importWorkbook,create:f.create,state:f.state,detail:f.detail,cancel:f.cancel,retry:f.retry});registerIpcHandlers(()=>7)});
 it.each([C.housingBindingImport,C.housingBindingCreate,C.housingBindingState,C.housingBindingDetail,C.housingBindingCancel,C.housingBindingRetry,C.housingBindingTemplate,C.housingBindingTemplateFolder])('blocks source frames before accessing %s',async channel=>{
  await expect(f.handlers.get(channel)!({...event,senderFrame:{}})).rejects.toThrow('非受信');expect(f.service).not.toHaveBeenCalled();expect(f.open).not.toHaveBeenCalled();expect(f.template).not.toHaveBeenCalled();
 });
 it('requires the matter grant before offering file access',async()=>{
  f.service.mockRejectedValue(new Error('未授权'));await expect(f.handlers.get(C.housingBindingImport)!(event)).rejects.toThrow('未授权');expect(f.open).not.toHaveBeenCalled();
 });
 it('accepts only the native picker file and limits its size before reading',async()=>{
  f.open.mockResolvedValue({canceled:false,filePaths:['C:/approved.xlsx']});f.stat.mockResolvedValue({isFile:()=>true,size:100});f.read.mockResolvedValue(Buffer.from('approved'));
  await f.handlers.get(C.housingBindingImport)!(event,'C:/secret.txt');expect(f.read).toHaveBeenCalledExactlyOnceWith('C:/approved.xlsx');expect(f.importWorkbook).toHaveBeenCalledWith(Buffer.from('approved'),'approved.xlsx');
  f.read.mockClear();f.stat.mockResolvedValue({isFile:()=>true,size:11*1024*1024});await expect(f.handlers.get(C.housingBindingImport)!(event)).rejects.toThrow('10MB');expect(f.read).not.toHaveBeenCalled();
 });
 it('cancellation does not read files and detail rejects invalid job ids',async()=>{
  f.open.mockResolvedValue({canceled:true,filePaths:[]});expect(await f.handlers.get(C.housingBindingImport)!(event)).toBeNull();expect(f.read).not.toHaveBeenCalled();
  await expect(f.handlers.get(C.housingBindingDetail)!(event,'../../private')).rejects.toThrow('格式无效');expect(f.detail).not.toHaveBeenCalled();
 });
});
