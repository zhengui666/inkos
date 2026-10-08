import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CreationTaskCoordinator} from '../creation/coordinator.js';
import {SchedulerStore, type ScheduledChapter} from '../pipeline/scheduler-store.js';
import {AutonomousChapterRunner, type SchedulerPublisher} from '../pipeline/autonomous-chapters.js';
import {inferCreationPlan,creationBook} from '../creation/contracts.js';
import {SchedulerPublisherRegistry,createDefaultSchedulerPublisherRegistry} from '../publishing/scheduler-publisher-registry.js';
import {RemoteWorkStore} from '../publishing/work-creation-store.js';
import {StateManager} from '../state/manager.js';
const roots:string[]=[],closers:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closers.splice(0).reverse())await close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'inkos-creation-remote-flow-'));roots.push(root);
 const scheduler=new SchedulerStore(join(root,'.inkos/harness.sqlite'));closers.push(()=>scheduler.close());
 const coordinator=new CreationTaskCoordinator(root,{} as any,scheduler,1);closers.push(()=>coordinator.close());
 const request={id:randomUUID(),kind:'short' as const,brief:'An original isolated fixture about a locksmith who repays a debt.'};
 const provisional=inferCreationPlan(request,{language:'en',daemon:{market:{platform:'meganovel'}}} as any);
 const task=coordinator.tasks.create(request,{...provisional,blurb:'A locksmith risks her livelihood to repay an impossible debt.'});
 coordinator.tasks.update(task.id,current=>({...current,foundation:'completed',planStatus:'ready',phase:'writing'}));
 const dest={provider:'fixture',platform:'meganovel' as const,accountId:'account',accountLabel:'authorized fixture',sessionId:'existing session'};
 const events:string[]=[];let found=true,afterInspect:undefined|(()=>void|Promise<void>);
 const schema=z.object({accountLabel:z.string(),remoteBookId:z.string()});
 const registry=new SchedulerPublisherRegistry().register({provider:'fixture',parseConfiguration:v=>schema.parse(v),target:v=>({platform:'meganovel',...v}),accountId:()=>dest.accountId,
  create:()=>({reconcile:async()=>undefined,ready:async()=>{events.push('chapter-ready');},publish:async()=>{events.push('chapter-publish');return{status:'published' as const,remoteChapterId:'simulated-chapter-1',evidence:'Simulated adapter receipt; no platform call.'};}}),
  newWork:{parseConfiguration:v=>v,createPort:()=>({withScope:async(_d,_s,fn)=>fn(),inspect:async input=>{events.push('inspect');await afterInspect?.();return{destination:input.destination};},
   create:async()=>{events.push('create');return{remoteBookId:'simulated-book-1'};},observe:async run=>{events.push('observe');return found?{status:'found',receipt:{operationId:run.id,destination:run.input.destination,metadata:run.input.metadata,remoteBookId:'simulated-book-1',provenance:'independently_observed',observedAt:Date.now(),evidence:'Simulated independent book readback'}}:{status:'unknown'};}}),
   chapterBinding:run=>({provider:'fixture',workId:run.input.workId,targetId:run.targetId!,configuration:{accountLabel:dest.accountLabel,remoteBookId:run.receipt!.remoteBookId}})}});
 const config={version:1,newWorks:[{destination:dest,configuration:{}}]};
 const publisher=await registry.create(root,config);closers.push(()=>publisher.close());
 const input={workId:task.workId,chapterNumber:1,revisionId:'reviewed-r1',signal:new AbortController().signal};
 const job=scheduler.reserve(task.workId,1,Date.now(),1)!;
 const reviewed:ScheduledChapter={...job,phase:'publishing' as const,revisionId:input.revisionId,reviewReceipt:{inputs:{version:1,plan:null,authorBrief:null,bookRules:null},revisionId:input.revisionId,reviewedAt:Date.now(),summary:'Simulated review acceptance',observations:[]}};
 vi.spyOn(StateManager.prototype,'loadBookConfig').mockResolvedValue({...creationBook(task),status:'active'});
 const run=async(selected:SchedulerPublisher=publisher,current:ScheduledChapter=reviewed)=>{
  scheduler.save(current,'fixture-reviewed');
  const runner=new AutonomousChapterRunner(root,{} as any,scheduler,{publisher:coordinator.publisher(selected),retryDelayMs:1});
  // Prose and review are controlled fixtures; exercise the real durable publication lifecycle only.
  vi.spyOn(runner as any,'chapterRevision').mockResolvedValue({revisionId:input.revisionId,observations:[]});
  const result=await runner.run(current,input.signal);coordinator.sync(task.workId);return result;
 };
 return{root,scheduler,coordinator,task,publisher,input,events,reviewed,run,restartPublisher:async()=>{await publisher.close();const next=await registry.create(root,config);closers.push(()=>next.close());return next;},found:(v:boolean)=>found=v,
  onInspect:(fn:()=>void|Promise<void>)=>afterInspect=fn,pause:()=>{const t=coordinator.tasks.get(task.id);coordinator.tasks.control(t.id,'paused',t.version);}};
}
describe('creation → new remote work → existing chapter publication (simulated adapters)',()=>{
 it('readonly readiness never creates; reviewed chapter then creates, reads back and publishes',async()=>{const f=await fixture();await f.coordinator.publisher(f.publisher).ready(f.task.workId,f.input.signal);expect(f.events).toEqual([]);const result=await f.run();expect(result.phase).toBe('completed');expect(result.publication?.evidence).toContain('Simulated');expect(f.events).toEqual(['inspect','create','observe','chapter-ready','chapter-publish']);});
 it('missing or changed review receipt prevents even remote-book creation',async()=>{const f=await fixture();const result=await f.run(f.publisher,{...f.reviewed,reviewReceipt:undefined});expect(result.phase).toBe('reviewing');expect(f.events).toEqual([]);});
 it('authority changes during new-book inspection return to review before any create attempt',async()=>{
  const f=await fixture();
  f.onInspect(async()=>{const dir=join(new StateManager(f.root).bookDir(f.task.workId),'story/runtime');await mkdir(dir,{recursive:true});await writeFile(join(dir,'chapter-0001.user-brief.md'),'Reveal the sender now.');});
  const result=await f.run();expect(result.phase).toBe('reviewing');expect(result.reviewReceipt).toBeUndefined();
  expect(f.events).toEqual(['inspect']);
  const store=new RemoteWorkStore(join(f.root,'.inkos/harness.sqlite'));try{expect(store.forWork(f.task.workId)?.attempts).toBe(0);}finally{store.close();}
 });
 it('unknown creation blocks task resumably and next attempt only reads back the same operation',async()=>{const f=await fixture();f.found(false);const first=await f.run();expect(first.error?.code).toBe('CREATION_PUBLISHER_REQUIRED');expect(f.coordinator.tasks.get(f.task.id).phase).toBe('blocked');expect(f.events).toEqual(['inspect','create','observe']);f.found(true);const task=f.coordinator.tasks.get(f.task.id);f.coordinator.tasks.control(task.id,'run',task.version);const next=await f.run(f.publisher,{...first,nextAttemptAt:0});expect(next.phase).toBe('completed');expect(f.events.filter(e=>e==='create')).toHaveLength(1);expect(f.events.filter(e=>e==='chapter-publish')).toHaveLength(1);});
 it('reconciles a retained unknown remote-book creation after restart before rejecting edited local authority',async()=>{
  const f=await fixture();f.found(false);const first=await f.run();expect(first.error?.code).toBe('CREATION_PUBLISHER_REQUIRED');
  const dir=join(new StateManager(f.root).bookDir(f.task.workId),'story/runtime');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'chapter-0001.user-brief.md'),'Changed after unknown book creation.');
  f.found(true);const task=f.coordinator.tasks.get(f.task.id);f.coordinator.tasks.control(task.id,'run',task.version);
  const restarted=await f.restartPublisher();const result=await f.run(restarted,{...first,nextAttemptAt:0});
  expect(result.phase).toBe('reviewing');expect(result.reviewReceipt).toBeUndefined();
  expect(f.events.filter(e=>e==='create')).toHaveLength(1);expect(f.events.filter(e=>e==='observe')).toHaveLength(2);
  expect(f.events).not.toContain('chapter-publish');
  const store=new RemoteWorkStore(join(f.root,'.inkos/harness.sqlite'));try{expect(store.forWork(f.task.workId)?.phase).toBe('bound');expect(store.forWork(f.task.workId)?.attempts).toBe(1);}finally{store.close();}
 });
 it('keeps repeated unknown remote-book readback resumable without consuming the generic failure budget',async()=>{
  const f=await fixture();f.found(false);let job=await f.run();
  const restarted=await f.restartPublisher();
  for(let attempt=0;attempt<4;attempt++){
   const task=f.coordinator.tasks.get(f.task.id);f.coordinator.tasks.control(task.id,'run',task.version);
   job=await f.run(restarted,{...job,nextAttemptAt:0});
   expect(job.phase).toBe('publishing');expect(job.failures).toBe(0);expect(job.error?.code).toBe('CREATION_PUBLISHER_REQUIRED');
  }
  expect(f.events.filter(e=>e==='create')).toHaveLength(1);expect(f.events.filter(e=>e==='observe')).toHaveLength(5);
  expect(f.events).not.toContain('chapter-publish');
 });
 it('pause during create preflight prevents a reservation and all remote mutation',async()=>{const f=await fixture();f.onInspect(f.pause);await expect(f.coordinator.publisher(f.publisher).publish(f.input)).rejects.toMatchObject({code:'CREATION_PUBLISHER_REQUIRED'});expect(f.events).toEqual(['inspect']);const store=new RemoteWorkStore(join(f.root,'.inkos/harness.sqlite'));try{expect(store.forWork(f.task.workId)?.attempts).toBe(0);}finally{store.close();}});
 it('pause during async chapter readiness prevents submission',async()=>{const f=await fixture();const publish=vi.fn();const configured:SchedulerPublisher={ready:async()=>{f.pause();},publish};await expect(f.coordinator.publisher(configured).publish(f.input)).rejects.toMatchObject({code:'CREATION_PAUSED'});expect(publish).not.toHaveBeenCalled();});
 it('built-in MegaNovel persists unsupported and retains the reviewed local chapter',async()=>{const f=await fixture();const p=await createDefaultSchedulerPublisherRegistry().create(f.root,{version:1,newWorks:[{destination:{provider:'meganovel',platform:'meganovel',accountId:'account',accountLabel:'configured',sessionId:'existing'},configuration:{}}]});closers.push(()=>p.close());const result=await f.run(p);expect(result.phase).toBe('publishing');expect(result.reviewReceipt?.revisionId).toBe(f.input.revisionId);expect(result.publication).toBeUndefined();expect(result.error?.message).toContain('REMOTE_WORK_UNSUPPORTED');expect(f.coordinator.tasks.get(f.task.id).phase).toBe('blocked');});
 it('legacy task without public blurb never publishes its raw author instructions as metadata',async()=>{const f=await fixture();f.coordinator.tasks.update(f.task.id,current=>({...current,plan:{...current.plan,blurb:undefined}}));const result=await f.run();expect(result.error?.code).toBe('CREATION_PUBLISHER_REQUIRED');expect(result.error?.message).toContain('raw author brief');expect(f.events).toEqual([]);});
});
