import { beforeEach, expect, it, vi } from 'vitest';
const f=vi.hoisted(()=>({handlers:new Map<string,(event:any,...args:any[])=>Promise<unknown>>(),submit:vi.fn(),get:vi.fn(),cancelPending:vi.fn(),retryFailed:vi.fn(),service:vi.fn(),business:vi.fn()}));
vi.mock('electron',()=>({BrowserWindow:class{},session:{},ipcMain:{handle:(name:string,listener:any)=>f.handlers.set(name,listener)}}));
vi.mock('./runtime',()=>({appRuntime:{returnBatches:()=>{f.service();return {submit:f.submit,get:f.get,cancelPending:f.cancelPending,retryFailed:f.retryFailed}}}}));
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../core/ipc/channels';
const frame={},event={sender:{id:7,mainFrame:frame},senderFrame:frame};
beforeEach(()=>{vi.clearAllMocks();f.handlers.clear();f.business.mockImplementation(operation=>operation());registerIpcHandlers(()=>7,{businessOperation:f.business});});

it('returns registration immediately through the trusted batch endpoint and marks mutations as business operations',async()=>{
  const input={matterIds:['first','second'],startDate:'2026-11-01',endDate:'2026-11-25'};
  const created={batchId:'batch-test',taskIds:['task-1','task-2'],count:2};f.submit.mockResolvedValue(created);
  expect(await f.handlers.get(IPC_CHANNELS.matterRunBatch)!(event,'guangdong-hrss',input)).toEqual(created);
  expect(f.submit).toHaveBeenCalledExactlyOnceWith('guangdong-hrss',input);expect(f.business).toHaveBeenCalledTimes(1);
});
it('forwards batch reads, cancellation and failed-only retry with exact system scope',async()=>{
  f.get.mockResolvedValue({tasks:[]});f.cancelPending.mockResolvedValue({cancelled:2});f.retryFailed.mockResolvedValue({count:1});
  await f.handlers.get(IPC_CHANNELS.returnBatchGet)!(event,'guangdong-hrss','batch-test');
  expect(f.get).toHaveBeenCalledExactlyOnceWith('guangdong-hrss','batch-test');expect(f.business).not.toHaveBeenCalled();
  await f.handlers.get(IPC_CHANNELS.returnBatchCancelPending)!(event,'guangdong-hrss','batch-test');
  await f.handlers.get(IPC_CHANNELS.returnBatchRetryFailed)!(event,'guangdong-hrss','batch-test');
  expect(f.cancelPending).toHaveBeenCalledExactlyOnceWith('guangdong-hrss','batch-test');expect(f.retryFailed).toHaveBeenCalledExactlyOnceWith('guangdong-hrss','batch-test');expect(f.business).toHaveBeenCalledTimes(2);
});
it.each([IPC_CHANNELS.matterRunBatch,IPC_CHANNELS.returnBatchGet,IPC_CHANNELS.returnBatchCancelPending,IPC_CHANNELS.returnBatchRetryFailed])('rejects child frames and other windows at %s before accessing batch services',async channel=>{
  for(const spoofed of [{...event,senderFrame:{}},{...event,sender:{id:8,mainFrame:frame}}]) await expect(f.handlers.get(channel)!(spoofed,'guangdong-hrss','batch-test')).rejects.toThrow('非受信');
  expect(f.service).not.toHaveBeenCalled();
});
