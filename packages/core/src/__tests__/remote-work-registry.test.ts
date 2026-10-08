import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {SchedulerPublisherRegistry,createDefaultSchedulerPublisherRegistry} from '../publishing/scheduler-publisher-registry.js';
import {RemoteWorkStore} from '../publishing/work-creation-store.js';
import {PublishingStore} from '../publishing/store.js';
import type {RemoteWorkDestination,RemoteWorkRun} from '../publishing/work-creation-contracts.js';
import type {RemoteWorkCreationPort} from '../publishing/work-creation-service.js';
import type {SchedulerPublisher} from '../pipeline/autonomous-chapters.js';
const roots:string[]=[],publishers:Array<SchedulerPublisher&{close():Promise<void>}>=[];
afterEach(async()=>{await Promise.allSettled(publishers.splice(0).map(p=>p.close()));for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const scope:RemoteWorkDestination={provider:'fixture',platform:'meganovel',accountLabel:'explicit account',accountId:'verified-account',sessionId:'existing-session'};
const metadata={title:'Fixture only',blurb:'A story for an isolated simulated adapter test.',genre:'fantasy',language:'en' as const,aiAssisted:true};
const schema=z.object({accountLabel:z.string(),remoteBookId:z.string()}).strict();
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'inkos-remote-registry-'));roots.push(root);
 const registry=new SchedulerPublisherRegistry(),events:string[]=[];
 let accountId=scope.accountId;
 let found=true,release:(()=>void)|undefined;
 const port:RemoteWorkCreationPort={withScope:async(_s,_a,fn)=>fn(),inspect:async i=>({destination:i.destination}),
  create:async()=>{events.push('create');return{remoteBookId:'simulated-remote-id'};},
  observe:async run=>{events.push('observe');return found?{status:'found',receipt:{operationId:run.id,destination:run.input.destination,metadata:run.input.metadata,
   remoteBookId:'simulated-remote-id',provenance:'independently_observed',observedAt:Date.now(),evidence:'Simulated port independent observation'}}:{status:'unknown'};},
  close:async()=>{events.push('close-port');}};
 const child={ready:vi.fn(async()=>{events.push('chapter-ready');}),publish:vi.fn(async()=>{events.push('chapter-publish');return{status:'published' as const,remoteChapterId:'simulated-chapter',evidence:'Simulated adapter receipt'};}),close:vi.fn(async()=>{events.push('close-child');})};
 const derive=(run:RemoteWorkRun)=>({provider:'fixture',workId:run.input.workId,targetId:run.targetId!,configuration:{accountLabel:run.input.destination.accountLabel,remoteBookId:run.receipt!.remoteBookId}});
 registry.register({provider:'fixture',parseConfiguration:v=>schema.parse(v),target:v=>({platform:'meganovel',...v}),accountId:()=>accountId,create:()=>child,
  newWork:{parseConfiguration:v=>z.object({approved:z.literal(true)}).strict().parse(v),createPort:()=>port,chapterBinding:run=>derive(run)}});
 const config={version:1,newWorks:[{destination:scope,configuration:{approved:true}}]};
 const request={workId:'new-work',platform:'meganovel',metadata,signal:new AbortController().signal};
 const open=async()=>{const p=await registry.create(root,config);publishers.push(p);return p;};
 return{root,registry,events,port,child,config,request,open,account:(v:string)=>accountId=v,found:(v:boolean)=>found=v,derive,
  defer:()=>new Promise<void>(r=>release=r),release:()=>release?.()};
}
describe('new-work routing uses simulated ports only',()=>{
 it('ready stays read-only; only explicit ensure creates then delegates existing chapter pipeline',async()=>{const f=await fixture(),p=await f.open();await expect(p.ready(f.request.workId,f.request.signal)).rejects.toMatchObject({code:'PUBLISHING_BINDING_MISSING'});expect(f.events).toEqual([]);await p.ensureWork!(f.request);expect(f.events).toEqual(['create','observe']);await p.ready(f.request.workId,f.request.signal);expect(await p.publish({workId:f.request.workId,chapterNumber:1,revisionId:'reviewed-revision',signal:f.request.signal})).toMatchObject({status:'published',evidence:'Simulated adapter receipt'});expect(f.events).toEqual(['create','observe','chapter-ready','chapter-publish']);});
 it('restart recovers bound target and derives chapter config without another create/observation',async()=>{const f=await fixture();let p=await f.open();await p.ensureWork!(f.request);await p.close();p=await f.open();await p.ensureWork!(f.request);expect(f.events.filter(x=>x==='create')).toHaveLength(1);expect(f.events.filter(x=>x==='observe')).toHaveLength(1);await p.ready(f.request.workId,f.request.signal);});
 it('unknown result restarts in readback-only mode and never reaches chapter publisher',async()=>{const f=await fixture();f.found(false);let p=await f.open();await expect(p.ensureWork!(f.request)).rejects.toMatchObject({code:'REMOTE_WORK_RECONCILIATION_REQUIRED'});await p.close();p=await f.open();await expect(p.ensureWork!(f.request)).rejects.toMatchObject({code:'REMOTE_WORK_RECONCILIATION_REQUIRED'});expect(f.events.filter(x=>x==='create')).toHaveLength(1);expect(f.events.filter(x=>x==='observe')).toHaveLength(2);expect(f.child.publish).not.toHaveBeenCalled();f.found(true);await p.ensureWork!(f.request);expect(f.events.filter(x=>x==='create')).toHaveLength(1);});
 it('built-in MegaNovel new creation is explicit unsupported with no transport',async()=>{const f=await fixture();const p=await createDefaultSchedulerPublisherRegistry().create(f.root,{version:1,newWorks:[{destination:{...scope,provider:'meganovel'},configuration:{}}]});publishers.push(p);await expect(p.ensureWork!(f.request)).rejects.toMatchObject({code:'REMOTE_WORK_UNSUPPORTED'});const store=new RemoteWorkStore(join(f.root,'.inkos/harness.sqlite'));try{expect(store.forWork('new-work')).toMatchObject({phase:'ready',attempts:0,blocker:{status:'unsupported'}});}finally{store.close();}});
 it('missing default for the selected platform never guesses another destination',async()=>{const f=await fixture(),p=await f.open();await expect(p.ensureWork!({...f.request,platform:'qidian'})).rejects.toMatchObject({code:'REMOTE_WORK_NEEDS_SETUP'});expect(f.events).toEqual([]);});
 it('concurrent duplicate ensures create one remote book and child binding',async()=>{const f=await fixture(),p=await f.open();await Promise.all([p.ensureWork!(f.request),p.ensureWork!(f.request)]);expect(f.events).toEqual(['create','observe']);});
 it('changed frozen metadata after uncertain create blocks before another transport action',async()=>{const f=await fixture();f.found(false);const p=await f.open();await expect(p.ensureWork!(f.request)).rejects.toThrow();const before=[...f.events];await expect(p.ensureWork!({...f.request,metadata:{...metadata,title:'different'}})).rejects.toMatchObject({code:'REMOTE_WORK_INPUT_CONFLICT'});expect(f.events).toEqual(before);});
 it('manual rebind cannot bypass an unresolved creation attempt',async()=>{const f=await fixture();f.found(false);const p=await f.open();await expect(p.ensureWork!(f.request)).rejects.toThrow();const store=new PublishingStore(join(f.root,'.inkos/harness.sqlite'));try{const target=store.mapBook({workId:'new-work',platform:'meganovel',accountLabel:'explicit account',remoteBookId:'other-book'});await expect(f.registry.create(f.root,{version:1,bindings:[{provider:'fixture',workId:'new-work',targetId:target.id,configuration:{accountLabel:target.accountLabel,remoteBookId:target.remoteBookId}}]})).rejects.toMatchObject({code:'PUBLISHING_RECONCILIATION_REQUIRED'});}finally{store.close();}});
 it('close waits for in-flight ensure before closing port/store',async()=>{const f=await fixture(),p=await f.open();let started!:()=>void;const admitted=new Promise<void>(r=>started=r),hold=f.defer();f.port.create=async()=>{started();await hold;return{remoteBookId:'simulated-remote-id'};};const op=p.ensureWork!(f.request);await admitted;let closed=false;const closing=p.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);expect(f.events).not.toContain('close-port');f.release();await op;await closing;expect(f.events.at(-1)).toBe('close-port');});
 it('wrong actual account in derived chapter transport cannot instantiate a publisher',async()=>{const f=await fixture();f.account('different-account');const p=await f.open();await expect(p.ensureWork!(f.request)).rejects.toMatchObject({code:'REMOTE_WORK_ACCOUNT_MISMATCH'});expect(f.child.publish).not.toHaveBeenCalled();expect(f.events).toEqual(['create','observe']);});
 it('restarted explicit binding must retain the observed actual account before child creation',async()=>{const f=await fixture();const p=await f.open();await p.ensureWork!(f.request);const store=new RemoteWorkStore(join(f.root,'.inkos/harness.sqlite'));let run:RemoteWorkRun;try{run=store.forWork(f.request.workId)!;}finally{store.close();}await p.close();f.account('different-account');await expect(f.registry.create(f.root,{version:1,bindings:[f.derive(run)]})).rejects.toMatchObject({code:'REMOTE_WORK_ACCOUNT_MISMATCH'});});
 it('cached bound route cannot accept a changed frozen request',async()=>{const f=await fixture(),p=await f.open();await p.ensureWork!(f.request);await expect(p.ensureWork!({...f.request,metadata:{...metadata,title:'Changed'}})).rejects.toMatchObject({code:'REMOTE_WORK_INPUT_CONFLICT'});expect(f.events).toEqual(['create','observe']);});
 it('concurrent distinct payloads never share a successful pending response',async()=>{const f=await fixture(),p=await f.open();const first=p.ensureWork!(f.request);await expect(p.ensureWork!({...f.request,metadata:{...metadata,title:'Changed'}})).rejects.toMatchObject({code:'REMOTE_WORK_INPUT_CONFLICT'});await first;expect(f.events).toEqual(['create','observe']);});

});
