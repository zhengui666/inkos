import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({ instances: [] as any[], config: {} as any, gate: undefined as any, jobs: [] as string[], aborted: false }));
vi.mock('@actalk/inkos-core', async importOriginal => {
 const actual=await importOriginal<typeof import('@actalk/inkos-core')>();
 return {...actual,createLLMClient:vi.fn(()=>({})),loadProjectConfig:vi.fn(async()=>f.config),Scheduler:class extends actual.Scheduler {
  constructor(config:any){super(config);f.instances.push(this);const scheduler=this as any;
   scheduler.state={listBooks:async()=>['old-authorized','old-excluded','old-paused'],loadBookConfig:async(id:string)=>({id,status:id==='old-paused'?'paused':'active',targetChapters:5}),bookDir:(id:string)=>id,isCompleteBookDirectory:async()=>true,getNextChapterNumber:async()=>1};
   scheduler.pipeline.runRadar=async()=>({recommendations:[],marketSummary:'Synthetic controller integration fixture',timestamp:new Date().toISOString()});
   scheduler.chapters.run=async(job:any,signal:AbortSignal)=>{f.jobs.push(job.workId);signal.addEventListener('abort',()=>{f.aborted=true;},{once:true});await f.gate?.promise;signal.throwIfAborted();const finished={...job,phase:'completed'};scheduler.store.save(finished,'synthetic-fixture-completed');return finished;};
  }
 }};
});
import { SchedulerStore } from '@actalk/inkos-core';
import { createStudioServer, shutdownStudioServer } from '../api/server.js';
let root:string;const apps:ReturnType<typeof createStudioServer>[]=[];
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
async function settle(){for(let n=0;n<30;n++)await new Promise(r=>setImmediate(r));}
const post=(app:ReturnType<typeof createStudioServer>,action:string)=>Promise.resolve(app.request('/api/v1/daemon/'+action,{method:'POST'}));
function app(){const value=createStudioServer(f.config,root);apps.push(value);return value;}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'inkos-independent-owner-'));f.instances=[];f.jobs=[];f.gate=undefined;f.aborted=false;f.config={name:'fixture',version:'0.1.0',language:'en',llm:{model:'fixture',provider:'openai'},notify:[],daemon:{workIds:['old-authorized','old-paused'],publicationPollMs:180000,schedule:{writeCron:'*/15 * * * *',radarCron:'0 */6 * * *'},maxConcurrentBooks:1,chaptersPerCycle:1,retryDelayMs:1000,cooldownAfterChapterMs:0,maxChaptersPerDay:5}};});
afterEach(async()=>{f.gate?.resolve();await Promise.all(apps.splice(0).map(value=>shutdownStudioServer(value)));await rm(root,{recursive:true,force:true});});
describe('independent Studio HTTP through real Scheduler and SQLite owner',()=>{
 it('dispatches only the allowed active old book through the real calendar scheduler',async()=>{const server=app();expect((await post(server,'start')).status).toBe(200);await settle();expect(f.jobs).toEqual(['old-authorized']);const store=new SchedulerStore(join(root,'.inkos/harness.sqlite'));try{expect(store.latest('old-authorized')?.phase).toBe('completed');expect(store.latest('old-excluded')).toBeUndefined();expect(store.latest('old-paused')).toBeUndefined();}finally{store.close();}await post(server,'stop');});
 it('retains the real owner while abort drains, rejects other app startup, then releases it',async()=>{f.gate=gate();const server=app();await post(server,'start');await settle();expect(f.jobs).toEqual(['old-authorized']);let done=false;const stopping=post(server,'stop').then(r=>{done=true;return r;});await settle();expect(f.aborted).toBe(true);expect(done).toBe(false);const store=new SchedulerStore(join(root,'.inkos/harness.sqlite'));try{expect(store.runningOwner()).toBeDefined();const contender=app();const busy=await post(contender,'start');expect(busy.status).toBe(409);expect(await busy.text()).toContain('DAEMON_BUSY');expect((await post(server,'start')).status).toBe(409);f.gate.resolve();expect((await stopping).status).toBe(200);expect(store.runningOwner()).toBeUndefined();expect((await post(contender,'start')).status).toBe(200);await post(contender,'stop');}finally{store.close();}});
 it('observes a ledger-initiated stop and refuses replacement during its drain',async()=>{f.gate=gate();const server=app();await post(server,'start');await settle();const store=new SchedulerStore(join(root,'.inkos/harness.sqlite'));try{store.requestStop();(f.instances[0] as any).tick();await settle();expect(f.aborted).toBe(true);const status=await (await server.request('/api/v1/daemon')).json();expect(status).toMatchObject({running:false,phase:'stopping'});expect((await post(server,'start')).status).toBe(409);f.gate.resolve();await settle();await expect.poll(async()=>(await(await server.request('/api/v1/daemon')).json()).phase).toBe('stopped');expect(store.runningOwner()).toBeUndefined();expect((await post(server,'start')).status).toBe(200);await post(server,'stop');}finally{store.close();}});
});
