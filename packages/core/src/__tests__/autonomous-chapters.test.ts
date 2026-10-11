import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const fixture=vi.hoisted(()=>({status:'active',language:'zh' as 'zh'|'en',chapterWordCount:2400,minChapterLength:undefined as number|undefined,maxChapterLength:undefined as number|undefined,locked:false,events:[] as any[],goal:null as any,runGoal:vi.fn(),retryGoal:vi.fn()}));
vi.mock('../goals/service.js',()=>({ChapterGoalService:class {get(){return fixture.goal;}events(){return {events:fixture.events};}run(...args:any[]){return fixture.runGoal(...args);}retryTransientFailure(...args:any[]){return fixture.retryGoal(...args);}close(){}}}));
vi.mock('../state/manager.js',()=>({StateManager:class {constructor(private root:string){} bookDir(id:string){return join(this.root,id);}async loadBookConfig(id:string){const book={id,title:'Synthetic unit chapter',platform:'other',genre:'general',targetChapters:4,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',status:fixture.status,language:fixture.language,chapterWordCount:fixture.chapterWordCount,minChapterLength:fixture.minChapterLength,maxChapterLength:fixture.maxChapterLength};await mkdir(this.bookDir(id),{recursive:true});await writeFile(join(this.bookDir(id),'book.json'),JSON.stringify(book));return book;}async acquireBookLock(){if(fixture.locked)throw new Error('busy');fixture.locked=true;return async()=>{fixture.locked=false;};}}}));
vi.mock('../harness/work-store.js',()=>({loadWorkManifest:async()=>({profileId:'longform-novel'})}));
vi.mock('../harness/builtin-profiles.js',()=>({createBuiltInWorkProfileRegistry:()=>({require:()=>({})})}));
vi.mock('../skills/index.js',()=>({loadAvailableAgentSkills:async()=>({skills:[]}),resolveProfileSkillActivations:()=>[]}));
import { captureChapterReviewPolicy } from '../pipeline/review-inputs.js';
import { buildLengthSpec, chapterLengthDelivery } from '../utils/length-metrics.js';
import { AutonomousChapterRunner } from '../pipeline/autonomous-chapters.js';
import { SchedulerStore } from '../pipeline/scheduler-store.js';
const reviewInputs={version:2 as const,plan:null,authorBrief:null,bookRules:null,bookRulesJson:null,authorIntent:null,currentFocus:null,styleGuide:null,parentCanon:null,fanficCanon:null};
const roots:string[]=[];const stores:SchedulerStore[]=[];
beforeEach(()=>{fixture.status='active';fixture.language='zh';fixture.minChapterLength=undefined;fixture.maxChapterLength=undefined;fixture.locked=false;fixture.events=[];fixture.goal=null;vi.clearAllMocks();});
afterEach(async()=>{stores.splice(0).forEach(s=>s.close());await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
// These unit tests control retained revisions at the existing revision seam.
// Keep the final synchronous check on the same revision as the async check;
// the writing-only flow tests exercise both checks against real retained files.
function mockRetainedRevision(runner: AutonomousChapterRunner) {
 let currentRevision={revisionId:'revision-4',observations:[] as any[]};
 const revision=vi.fn().mockResolvedValue(currentRevision);
 vi.spyOn(runner as any,'chapterRevision').mockImplementation(async(...args:any[])=>{currentRevision=await revision(...args);return currentRevision;});
 vi.spyOn(runner as any,'chapterRevisionSync').mockImplementation(()=>currentRevision);
 return revision;
}
async function setup(){const root=await mkdtemp(join(tmpdir(),'inkos-autonomous-'));roots.push(root);const store=new SchedulerStore(join(root,'harness.sqlite'));stores.push(store);const first=store.reserve('novel',4,Date.now(),1)!;const job={...first,phase:'reviewing' as const};store.save(job,'fixture');const pipeline={writeChapters:vi.fn(),runWithAbortSignal:(_s:any,f:any)=>f(),runWithAgentContext:(_c:any,f:any)=>f(),reviewChapter:vi.fn(async(_book?:string,_chapter?:number,options?:{requireStoryClosure?:boolean})=>({reviewInputs,reviewPolicy:captureChapterReviewPolicy(fixture,options?.requireStoryClosure===true),summary:'Current retained revision reviewed.',observations:[]})),reviseDraft:vi.fn()};const publisher={reconcile:vi.fn(async()=>undefined),ready:vi.fn(async()=>{}),publish:vi.fn(async(_input?:any)=>({status:'published' as const,remoteChapterId:'remote-4'}))};let now=Date.now();const runner=new AutonomousChapterRunner(root,pipeline as any,store,{publisher,retryDelayMs:1,publicationPollMs:60000,now:()=>now});const revision=mockRetainedRevision(runner);return {root,store,job,pipeline,publisher,runner,revision,advance:()=>{now+=100000;}};}
const issue={code:'continuity',summary:'Unresolved source-supported issue',assessment:'issue',evidence:[]};
const closureEvidence={code:'story-closure',category:'quality',assessment:'observation',evidence:[],sourceRefs:[{sourceId:'chapter-4',quote:'The central conflict was resolved.'}]};
async function approvedBeforeSubmission(f:Awaited<ReturnType<typeof setup>>){
 f.publisher.publish.mockRejectedValueOnce(Object.assign(new Error('Pause before submission'),{code:'CHAPTER_PUBLICATION_PAUSED'}));
 const accepted=await f.runner.run(f.job,new AbortController().signal);
 expect(accepted.phase).toBe('publishing');expect(accepted.reviewReceipt).toBeDefined();
 return accepted;
}
it.each(['chapter-contract-inventory','chapter-contract-1'])('requires missing semantic evidence for %s without refunding retries or rewriting prose',async code=>{
 const f=await setup();(f.runner as any).options.persistentTransientRetries=true;
 const unknown={code,category:'quality',assessment:'unavailable',summary:'The revised author instruction is absent.',evidence:[],sourceRefs:[]};
 f.pipeline.reviewChapter.mockResolvedValue({reviewInputs,reviewPolicy:captureChapterReviewPolicy(fixture),summary:'Authority unavailable',observations:[unknown]} as any);
 const result=await f.runner.run(f.job,new AbortController().signal);
 expect(result.phase).toBe('blocked');expect(result.error?.code).toBe('CHAPTER_CONTRACT_EVIDENCE_REQUIRED');
 expect(result.reviewChecks).toBe(1);expect(result.reviewUnavailableChecks??0).toBe(0);
 for(let index=0;index<3;index++){f.advance();await f.runner.run(result,new AbortController().signal);}
 expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();
});
describe('autonomous retained chapter stages',()=>{
 it('publishes only the revision accepted under the existing book lock',async()=>{const f=await setup();f.revision.mockImplementation(async()=>{if(f.revision.mock.calls.length<=2)expect(fixture.locked).toBe(true);return {revisionId:'revision-4',observations:[]};});const result=await f.runner.run(f.job,new AbortController().signal);expect(result.phase).toBe('completed');expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(result.reviewReceipt).toMatchObject({revisionId:'revision-4',summary:'Current retained revision reviewed.'});expect(f.publisher.publish).toHaveBeenCalledWith(expect.objectContaining({revisionId:'revision-4'}));expect(fixture.locked).toBe(false);});
 it('does not accept a changed revision with new unresolved observations',async()=>{const f=await setup();f.revision.mockResolvedValueOnce({revisionId:'A',observations:[]}).mockResolvedValue({revisionId:'B',observations:[{...issue,code:'state-sync-required'}]});const result=await f.runner.run(f.job,new AbortController().signal);expect(result.phase).toBe('blocked');expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('retries an unavailable review without rewriting prose',async()=>{const f=await setup();f.revision.mockResolvedValueOnce({revisionId:'A',observations:[{code:'review-unavailable',summary:'provider timed out',evidence:[]}]}).mockResolvedValue({revisionId:'A',observations:[]});await f.runner.run(f.job,new AbortController().signal);expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).toHaveBeenCalledOnce();});
 it('performs at most one source-scoped repair and retains unresolved work',async()=>{const f=await setup();f.revision.mockResolvedValue({revisionId:'A',observations:[issue]});const result=await f.runner.run(f.job,new AbortController().signal);expect(result.phase).toBe('blocked');expect(f.pipeline.reviseDraft).toHaveBeenCalledWith('novel',4,'spot-fix',expect.any(String),expect.objectContaining({reviewFindings:expect.arrayContaining([issue])}));expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('routes a source-supported scene defect to chapter rework rather than surface patches',async()=>{const f=await setup();f.revision.mockResolvedValue({revisionId:'A',observations:[{...issue,repairScope:'structural'}]});const result=await f.runner.run(f.job,new AbortController().signal);expect(result.phase).toBe('blocked');expect(f.pipeline.reviseDraft).toHaveBeenCalledWith('novel',4,'rework',expect.any(String),expect.objectContaining({reviewFindings:expect.arrayContaining([expect.objectContaining({repairScope:'structural'})])}));expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce();expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('blocks premise-level repair without silently replacing the accepted foundation',async()=>{const f=await setup();f.revision.mockResolvedValue({revisionId:'A',observations:[{...issue,repairScope:'foundation'}]});const result=await f.runner.run(f.job,new AbortController().signal);expect(result.error?.code).toBe('CHAPTER_FOUNDATION_REVIEW_REQUIRED');expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('retains a started repair across an exception instead of resetting the budget',async()=>{const f=await setup();f.revision.mockResolvedValue({revisionId:'A',observations:[issue]});f.pipeline.reviseDraft.mockRejectedValue(new Error('provider failed'));const first=await f.runner.run(f.job,new AbortController().signal);expect(first.reviewAttempts).toBe(1);expect(fixture.locked).toBe(false);f.advance();const second=await f.runner.run(first,new AbortController().signal);expect(second.phase).toBe('blocked');expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce();});
 it('holds pending remote outcomes for later readback without a new writing call',async()=>{const f=await setup();f.publisher.publish.mockResolvedValue({status:'pending'} as any);const first=await f.runner.run(f.job,new AbortController().signal);expect(first.phase).toBe('publishing');expect(first.publication?.status).toBe('pending');expect(f.pipeline.writeChapters).not.toHaveBeenCalled();f.advance();await f.runner.run(first,new AbortController().signal);expect(f.publisher.publish).toHaveBeenCalledTimes(2);expect(f.pipeline.writeChapters).not.toHaveBeenCalled();});
 it('bounds unavailable transport retries and persists backoff',async()=>{const f=await setup();f.publisher.ready.mockRejectedValue(Object.assign(new Error('No configured browser'),{code:'PUBLISHING_UNAVAILABLE'}));let job=f.job as any;for(let i=0;i<3;i++){job=await f.runner.run(job,new AbortController().signal);f.advance();}expect(job.phase).toBe('blocked');expect(f.publisher.ready).toHaveBeenCalledTimes(3);await f.runner.run(job,new AbortController().signal);expect(f.publisher.ready).toHaveBeenCalledTimes(3);expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();});
 it('respects an explicit pause before the first goal attempt',async()=>{const f=await setup();fixture.goal={id:f.job.goalId,status:'paused',desiredState:'paused',attempts:0,version:2,owner:null,budget:{expiresAt:Date.now()+60000}};fixture.events=[{type:'goal-created'},{type:'goal-paused-requested'}];const result=await f.runner.run({...f.job,phase:'writing'},new AbortController().signal);expect(result.phase).toBe('blocked');expect(fixture.runGoal).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('does no new work for a paused book',async()=>{const f=await setup();fixture.status='paused';const result=await f.runner.run(f.job,new AbortController().signal);expect(result).toEqual(f.job);expect(f.publisher.ready).not.toHaveBeenCalled();});
 it('a failed completion callback cannot turn accepted output into another write',async()=>{const f=await setup();(f.runner as any).options.onComplete=()=>{throw new Error('notification failed');};const result=await f.runner.run(f.job,new AbortController().signal);expect(result.phase).toBe('completed');expect(f.publisher.publish).toHaveBeenCalledOnce();await f.runner.run(result,new AbortController().signal);expect(f.publisher.publish).toHaveBeenCalledOnce();expect(f.pipeline.writeChapters).not.toHaveBeenCalled();});

});

describe('independent review policy receipts',()=>{
 it('binds the captured closure requirement and language outside the authoritative text inputs',async()=>{
  const f=await setup();const accepted=await approvedBeforeSubmission(f);
  expect(accepted.reviewReceipt).toMatchObject({reviewPolicy:{requireStoryClosure:false,language:'zh'},inputs:reviewInputs});
  expect(accepted.reviewReceipt?.inputs).not.toHaveProperty('requireStoryClosure');
  expect(accepted.reviewReceipt?.inputs).not.toHaveProperty('language');
 });
 it.each([false,true])('reviews again when unsubmitted closure policy changes from %s',async initial=>{
  const f=await setup();let closure=initial;(f.runner as any).options.requireStoryClosure=()=>closure;
  f.pipeline.reviewChapter.mockImplementation(async(_book,_chapter,options)=>({reviewInputs,
   reviewPolicy:captureChapterReviewPolicy(fixture,options?.requireStoryClosure===true),
   summary:'Ending verified.',observations:[closureEvidence]} as any));
  const accepted=await approvedBeforeSubmission(f);closure=!initial;
  const invalidated=await f.runner.run(accepted,new AbortController().signal);
  expect(invalidated.phase).toBe('reviewing');expect(invalidated.reviewReceipt).toBeUndefined();
  expect(invalidated.reviewChecks).toBe(1);expect(f.publisher.publish).toHaveBeenCalledOnce();
  const reviewed=await f.runner.run(invalidated,new AbortController().signal);
  expect(reviewed.phase).toBe('completed');expect(reviewed.reviewChecks).toBe(2);
  expect(reviewed.reviewReceipt).toMatchObject({reviewPolicy:{requireStoryClosure:!initial,language:'zh'}});
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();
 });
 it.each(['zh','en'] as const)('reviews again when unsubmitted language changes from %s',async initial=>{
  fixture.language=initial;const f=await setup();const accepted=await approvedBeforeSubmission(f);
  fixture.language=initial==='zh'?'en':'zh';
  const invalidated=await f.runner.run(accepted,new AbortController().signal);
  expect(invalidated.phase).toBe('reviewing');expect(invalidated.reviewReceipt).toBeUndefined();
  expect(f.publisher.publish).toHaveBeenCalledOnce();expect(invalidated.reviewChecks).toBe(1);
  const reviewed=await f.runner.run(invalidated,new AbortController().signal);
  expect(reviewed.phase).toBe('completed');expect(reviewed.reviewChecks).toBe(2);
  expect(reviewed.reviewReceipt).toMatchObject({reviewPolicy:captureChapterReviewPolicy(fixture)});
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();
 });
 it.each(['closure','language'] as const)('issues no acceptance receipt when %s policy changes during review',async changed=>{
  const f=await setup();let closure=false;(f.runner as any).options.requireStoryClosure=()=>closure;
  f.pipeline.reviewChapter.mockImplementation(async(_book,_chapter,options)=>{
   const reviewPolicy=captureChapterReviewPolicy(fixture,options?.requireStoryClosure===true);
   if(changed==='closure')closure=true;else fixture.language='en';
   return {reviewInputs,reviewPolicy,summary:'Captured policy reviewed.',observations:[]} as any;
  });
  const result=await f.runner.run(f.job,new AbortController().signal);
  expect(result.phase).toBe('reviewing');expect(result.reviewReceipt).toBeUndefined();expect(result.reviewChecks).toBe(1);
  expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();
 });
 it('rechecks policy at each publication mutation after a remote draft has been saved',async()=>{
  const f=await setup();let savedDraft=false;const submit=vi.fn();
  f.publisher.publish.mockImplementation(async input=>{
   await (input as any).beforeMutation();savedDraft=true;fixture.language='en';
   await (input as any).beforeMutation();submit();
   return {status:'published',remoteChapterId:'remote-4'};
  });
  const invalidated=await f.runner.run(f.job,new AbortController().signal);
  expect(savedDraft).toBe(true);expect(submit).not.toHaveBeenCalled();
  expect(invalidated.phase).toBe('reviewing');expect(invalidated.reviewReceipt).toBeUndefined();
  expect(invalidated.publicationStartedAt).toBeDefined();expect(invalidated.reviewChecks).toBe(1);
 });
 it('requires a fresh policy receipt for a legacy unsubmitted acceptance',async()=>{
  const f=await setup();const accepted=await approvedBeforeSubmission(f);
  const legacy={...accepted,reviewReceipt:{...accepted.reviewReceipt!,reviewPolicy:undefined}};
  f.store.save(legacy,'legacy-policy-receipt');
  const invalidated=await f.runner.run(legacy,new AbortController().signal);
  expect(invalidated.phase).toBe('reviewing');expect(invalidated.reviewReceipt).toBeUndefined();
  expect(f.publisher.publish).toHaveBeenCalledOnce();expect(invalidated.reviewChecks).toBe(1);
 });
 it.each(['submitted','pending'] as const)('reconciles a frozen %s attempt after restart without applying new policy to it',async status=>{
  const f=await setup();const frozen={status,remoteChapterId:'remote-4',evidence:'Original retained attempt.'};
  f.publisher.publish.mockResolvedValue(frozen as any);
  const accepted=await f.runner.run(f.job,new AbortController().signal);fixture.language='en';
  f.publisher.reconcile.mockResolvedValue(frozen as any);
  f.store.close();stores.splice(stores.indexOf(f.store),1);
  const reopened=new SchedulerStore(join(f.root,'harness.sqlite'));stores.push(reopened);
  const restarted=new AutonomousChapterRunner(f.root,f.pipeline as any,reopened,
   {publisher:f.publisher,retryDelayMs:1,requireStoryClosure:()=>true,now:()=>Date.now()+100000});
  const revision=mockRetainedRevision(restarted);
  const reconciled=await restarted.run(reopened.latest('novel')!,new AbortController().signal);
  expect(reconciled.reviewReceipt).toEqual(accepted.reviewReceipt);expect(reconciled.publication).toEqual(frozen);
  expect(revision).not.toHaveBeenCalled();expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();
  expect(f.publisher.publish).toHaveBeenCalledOnce();expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();
 });
 it('keeps completed history idle after restart even when closure and language change',async()=>{
  const f=await setup();const completed=await f.runner.run(f.job,new AbortController().signal);fixture.language='en';
  f.store.close();stores.splice(stores.indexOf(f.store),1);
  const reopened=new SchedulerStore(join(f.root,'harness.sqlite'));stores.push(reopened);
  const restarted=new AutonomousChapterRunner(f.root,f.pipeline as any,reopened,
   {publisher:f.publisher,retryDelayMs:1,requireStoryClosure:()=>true,now:()=>Date.now()+100000});
  const revision=mockRetainedRevision(restarted);f.publisher.ready.mockClear();
  const result=await restarted.run(reopened.latest('novel')!,new AbortController().signal);
  expect(result).toEqual(completed);expect(revision).not.toHaveBeenCalled();expect(f.publisher.ready).not.toHaveBeenCalled();
  expect(f.publisher.reconcile).toHaveBeenCalledOnce();expect(f.publisher.publish).toHaveBeenCalledOnce();
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(f.pipeline.writeChapters).not.toHaveBeenCalled();
 });
 it('preserves frozen publication identity and all budgets when a proven draft needs a fresh policy review',async()=>{
  const f=await setup();const accepted=await approvedBeforeSubmission(f);
  const retained={...accepted,reviewAttempts:1,reviewChecks:2,reviewUnavailableChecks:1,failures:2,
   publicationStartedAt:123,publication:{status:'pending' as const,remoteChapterId:'remote-4',evidence:'Retained draft package.'}};
  f.store.save(retained,'retained-draft');fixture.language='en';f.publisher.reconcile.mockResolvedValue({status:'draft'} as any);
  const invalidated=await f.runner.run(retained,new AbortController().signal);
  expect(invalidated).toMatchObject({phase:'reviewing',revisionId:'revision-4',publicationStartedAt:123,
   publication:retained.publication,reviewAttempts:1,reviewChecks:2,reviewUnavailableChecks:1,failures:2});
  expect(invalidated.reviewReceipt).toBeUndefined();expect(f.store.latest('novel')).toEqual(invalidated);
  expect(f.publisher.publish).toHaveBeenCalledOnce();expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();
 });
});


describe('revision-bound review and interrupted repair recovery',()=>{
 it('reviews an edited registered revision again even if metadata still has no issues',async()=>{const f=await setup();let current='A';f.revision.mockImplementation(async()=>({revisionId:current,observations:[]}));f.publisher.publish.mockResolvedValue({status:'pending'} as any);const accepted=await f.runner.run(f.job,new AbortController().signal);expect(accepted.reviewReceipt?.revisionId).toBe('A');current='B';f.advance();const invalidated=await f.runner.run(accepted,new AbortController().signal);expect(invalidated.phase).toBe('reviewing');expect(invalidated.reviewReceipt).toBeUndefined();expect(invalidated.reviewChecks).toBe(1);const reviewed=await f.runner.run(invalidated,new AbortController().signal);expect(reviewed.reviewReceipt?.revisionId).toBe('B');expect(reviewed.reviewChecks).toBe(2);expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);expect(f.publisher.publish).toHaveBeenLastCalledWith(expect.objectContaining({revisionId:'B'}));});
 it('does not publish a legacy phase without a durable current revision review receipt',async()=>{const f=await setup();const legacy={...f.job,phase:'publishing' as const,revisionId:'revision-4'};f.store.save(legacy,'legacy');const pending=await f.runner.run(legacy,new AbortController().signal);expect(pending.phase).toBe('reviewing');expect(f.publisher.publish).not.toHaveBeenCalled();const result=await f.runner.run(pending,new AbortController().signal);expect(result.reviewReceipt?.revisionId).toBe('revision-4');expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();});
 it('does not erase the audit budget through repeated edits',async()=>{const f=await setup();let current='A';f.revision.mockImplementation(async()=>({revisionId:current,observations:[]}));f.publisher.publish.mockResolvedValue({status:'pending'} as any);let job=await f.runner.run(f.job,new AbortController().signal);for(const next of ['B','C','D']){current=next;f.advance();job=await f.runner.run(job,new AbortController().signal);job=await f.runner.run(job,new AbortController().signal);}expect(job.phase).toBe('blocked');expect(job.error?.code).toBe('CHAPTER_REVIEW_BUDGET_EXHAUSTED');expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(3);expect(f.publisher.publish).toHaveBeenCalledTimes(3);});
 it('reconciles a repair committed just before stop and audits that revision without another repair',async()=>{const f=await setup(),controller=new AbortController();let current='A';f.revision.mockImplementation(async()=>({revisionId:current,observations:current==='A'?[issue]:[]}));f.pipeline.reviseDraft.mockImplementation(async()=>{current='B';controller.abort(new Error('ordinary daemon stop'));throw controller.signal.reason;});const stopped=await f.runner.run(f.job,controller.signal);expect(stopped.reviewAttempts).toBe(1);expect(stopped.reviewRepair?.revisionId).toBe('A');const restarted=new AutonomousChapterRunner(f.root,f.pipeline as any,f.store,{publisher:f.publisher,retryDelayMs:1});mockRetainedRevision(restarted).mockImplementation(async()=>({revisionId:current,observations:[]}));const result=await restarted.run(f.store.latest('novel')!,new AbortController().signal);expect(result.phase).toBe('completed');expect(result.reviewReceipt?.revisionId).toBe('B');expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce();expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);});
 it('retains a stopped repair attempt and blocks when a fresh audit still finds the issue',async()=>{const f=await setup(),controller=new AbortController();f.revision.mockResolvedValue({revisionId:'A',observations:[issue]});f.pipeline.reviseDraft.mockImplementation(async()=>{controller.abort(new Error('ordinary stop'));throw controller.signal.reason;});const stopped=await f.runner.run(f.job,controller.signal);const resumed=await f.runner.run(stopped,new AbortController().signal);expect(resumed.phase).toBe('blocked');expect(resumed.reviewAttempts).toBe(1);expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce();expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('will not reinterpret a canonical pending marker as an editorial repair',async()=>{const f=await setup();f.revision.mockResolvedValue({revisionId:'A',observations:[{code:'state-sync-required',summary:'Canonical state replay is pending.',evidence:[],assessment:'unavailable'}]});const result=await f.runner.run(f.job,new AbortController().signal);expect(result.phase).toBe('blocked');expect(result.error?.code).toBe('CHAPTER_STATE_RECOVERY_REQUIRED');expect(f.pipeline.reviewChapter).not.toHaveBeenCalled();expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();});
 it('rechecks newly added unresolved metadata before publishing an accepted revision',async()=>{const f=await setup();f.publisher.publish.mockResolvedValue({status:'pending'} as any);const accepted=await f.runner.run(f.job,new AbortController().signal);f.revision.mockResolvedValue({revisionId:'revision-4',observations:[issue]});f.advance();const result=await f.runner.run(accepted,new AbortController().signal);expect(result.phase).toBe('reviewing');expect(result.reviewReceipt).toBeUndefined();expect(f.publisher.publish).toHaveBeenCalledOnce();});
 it('retains audit attempts when the audit itself stops and bounds later read-only retries',async()=>{const f=await setup(),controller=new AbortController();f.pipeline.reviewChapter.mockImplementationOnce(async()=>{controller.abort(new Error('ordinary stop'));throw controller.signal.reason;});const stopped=await f.runner.run(f.job,controller.signal);expect(stopped.reviewChecks).toBe(1);expect(stopped.reviewAttempt?.revisionId).toBe('revision-4');const resumed=await f.runner.run(stopped,new AbortController().signal);expect(resumed.phase).toBe('completed');expect(resumed.reviewChecks).toBe(2);expect(resumed.reviewAttempt).toBeUndefined();expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);});
 it('passes the same current publishing chapter to readiness only for readback continuation',async()=>{const f=await setup();f.publisher.publish.mockResolvedValue({status:'pending'} as any);const accepted=await f.runner.run(f.job,new AbortController().signal);expect(f.publisher.ready.mock.calls[0]).toHaveLength(3);expect((f.publisher.ready.mock.calls[0] as any)[2]).toBeUndefined();f.advance();await f.runner.run(accepted,new AbortController().signal);expect(f.publisher.ready).toHaveBeenLastCalledWith('novel',expect.any(AbortSignal),4);});
 it('requires source-supported story closure before publishing a creation ending', async () => {
  const f=await setup(); (f.runner as any).options.requireStoryClosure=()=>true;
  const result=await f.runner.run(f.job,new AbortController().signal);
  expect(result.error?.code).toBe('STORY_CLOSURE_REVIEW_REQUIRED'); expect(f.publisher.publish).not.toHaveBeenCalled();
  expect(f.pipeline.reviewChapter).toHaveBeenCalledWith('novel',4,{requireStoryClosure:true});
 });
 it('accepts a positively evidenced ending and then uses the real publisher interface', async () => {
  const f=await setup(); (f.runner as any).options.requireStoryClosure=()=>true;
  f.pipeline.reviewChapter.mockResolvedValue({reviewInputs,reviewPolicy:captureChapterReviewPolicy(fixture,true),summary:'Ending verified.',observations:[closureEvidence]} as any);
  expect((await f.runner.run(f.job,new AbortController().signal)).phase).toBe('completed');
  expect(f.publisher.publish).toHaveBeenCalledOnce();
 });
 it('retains and backs off transient creation review failures without exhausting the editorial budget', async () => {
  const f=await setup(); (f.runner as any).options.persistentTransientRetries=true;
  f.pipeline.reviewChapter.mockRejectedValueOnce(Object.assign(new Error('temporary'),{code:'MODEL_UNAVAILABLE'}))
   .mockRejectedValueOnce(Object.assign(new Error('temporary'),{code:'MODEL_UNAVAILABLE'}))
   .mockRejectedValueOnce(Object.assign(new Error('temporary'),{code:'MODEL_UNAVAILABLE'}))
   .mockRejectedValueOnce(Object.assign(new Error('temporary'),{code:'MODEL_UNAVAILABLE'}));
  let job=f.job as any;
  for(let i=0;i<4;i++){job=await f.runner.run(job,new AbortController().signal);expect(job.phase).toBe('reviewing');f.advance();}
  job=await f.runner.run(job,new AbortController().signal);
  expect(job.phase).toBe('completed'); expect(job.reviewChecks).toBe(5);expect(job.reviewUnavailableChecks).toBe(4);
  expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).toHaveBeenCalledOnce();
 });
 it('never credits the same unavailable review again when a later readiness check fails', async () => {
  const f=await setup(); (f.runner as any).options.persistentTransientRetries=true;
  f.pipeline.reviewChapter.mockRejectedValueOnce(Object.assign(new Error('Review provider unavailable'),{code:'MODEL_UNAVAILABLE'}));
  let job=await f.runner.run(f.job,new AbortController().signal);
  expect(job).toMatchObject({reviewChecks:1,reviewUnavailableChecks:1});
  // Keep the old attempt marker, exactly as it is persisted after the failed audit.
  expect(job.reviewAttempt).toBeDefined();
  f.publisher.ready.mockRejectedValue(Object.assign(new Error('Transport temporarily unavailable'),{code:'PUBLISHING_UNAVAILABLE'}));
  f.store.close();stores.splice(stores.indexOf(f.store),1);
  const reopened=new SchedulerStore(join(f.root,'harness.sqlite'));stores.push(reopened);
  let now=Date.now()+100000;
  const restarted=new AutonomousChapterRunner(f.root,f.pipeline as any,reopened,
   {publisher:f.publisher,retryDelayMs:1,persistentTransientRetries:true,now:()=>now});
  for(let n=0;n<3;n++){
   now+=100000;job=await restarted.run(reopened.latest('novel')!,new AbortController().signal);
   expect(job).toMatchObject({reviewChecks:1,reviewUnavailableChecks:1});
  }
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();
  expect(f.publisher.publish).not.toHaveBeenCalled();
  f.publisher.ready.mockResolvedValue(undefined);now+=100000;
  mockRetainedRevision(restarted).mockResolvedValue({revisionId:'revision-4',observations:[]});
  job=await restarted.run(reopened.latest('novel')!,new AbortController().signal);
  expect(job).toMatchObject({phase:'completed',reviewChecks:2,reviewUnavailableChecks:1});
  expect(f.publisher.publish).toHaveBeenCalledOnce();expect(f.pipeline.writeChapters).not.toHaveBeenCalled();
 });
 it('credits a new unavailable review result even after its attempt marker is cleared', async () => {
  const f=await setup(); (f.runner as any).options.persistentTransientRetries=true;
  f.pipeline.reviewChapter.mockResolvedValueOnce({reviewInputs,reviewPolicy:captureChapterReviewPolicy(fixture),summary:'Review unavailable',observations:[],unavailable:true} as any);
  const waiting=await f.runner.run(f.job,new AbortController().signal);
  expect(waiting).toMatchObject({phase:'reviewing',reviewChecks:1,reviewUnavailableChecks:1});
  expect(waiting.reviewAttempt).toBeUndefined();expect(f.publisher.publish).not.toHaveBeenCalled();
  f.advance();const done=await f.runner.run(waiting,new AbortController().signal);
  expect(done).toMatchObject({phase:'completed',reviewChecks:2,reviewUnavailableChecks:1});
  expect(f.publisher.publish).toHaveBeenCalledOnce();expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();
 });
 it('rechecks pause after readiness and after review before any new write or publication', async () => {
  const f=await setup();let running=true;(f.runner as any).options.shouldContinue=()=>running;
  f.publisher.ready.mockImplementation(async()=>{running=false;});
  const job={...f.job,phase:'writing' as const};await f.runner.run(job,new AbortController().signal);
  expect(f.pipeline.writeChapters).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();
  running=true;f.publisher.ready.mockResolvedValue(undefined);f.pipeline.reviewChapter.mockImplementation(async()=>{running=false;return {reviewInputs,reviewPolicy:captureChapterReviewPolicy(fixture),summary:'Clean',observations:[]};});
  await f.runner.run(f.job,new AbortController().signal);expect(f.publisher.publish).not.toHaveBeenCalled();
 });

 it('releases a transient write into durable backoff and resumes the same goal automatically', async () => {
  const f=await setup();(f.runner as any).options.persistentTransientRetries=true;
  const failed={id:'same-goal',workId:'novel',version:2,owner:null,status:'failed',desiredState:'run',
    budget:{expiresAt:null,maxAttempts:1},error:{code:'GOAL_BUDGET_EXHAUSTED',message:'Attempts exhausted'},
    steps:[{id:'chapter-4',status:'pending',receipt:null,error:{code:'MODEL_UNAVAILABLE',message:'Temporary'}}]};
  fixture.goal={...failed,status:'ready',error:null};fixture.runGoal.mockResolvedValueOnce(failed);
  const job={...f.job,phase:'writing' as const,goalId:'same-goal'};
  const first=await f.runner.run(job,new AbortController().signal);
  expect(first.phase).toBe('writing');expect(first.error?.code).toBe('CREATION_TRANSIENT_BACKOFF');
  expect(first.nextAttemptAt).toBeGreaterThan(Date.now());expect(f.publisher.publish).not.toHaveBeenCalled();
  fixture.goal=failed;fixture.retryGoal.mockReturnValue({...failed,status:'ready',error:null,version:3});
  fixture.runGoal.mockResolvedValueOnce({...failed,status:'completed',error:null});f.advance();
  const resumed=await f.runner.run(first,new AbortController().signal);
  expect(fixture.retryGoal).toHaveBeenCalledWith('same-goal',2,'novel',1);
  expect(fixture.runGoal).toHaveBeenLastCalledWith('same-goal',3,expect.objectContaining({signal:expect.any(AbortSignal)}));
  expect(resumed.phase).toBe('completed');expect(f.publisher.publish).toHaveBeenCalledOnce();
 });
 it('never grants a retry for uncertain retained output even in persistent creation mode', async () => {
  const f=await setup();(f.runner as any).options.persistentTransientRetries=true;
  fixture.goal={id:'uncertain-goal',version:1,owner:null,status:'reconciliation_required',desiredState:'run',
    budget:{expiresAt:null,maxAttempts:1},error:{code:'CHAPTER_REVISION_SNAPSHOT_CHANGED',message:'Needs reconciliation'},steps:[]};
  const result=await f.runner.run({...f.job,phase:'writing'},new AbortController().signal);
  expect(result.phase).toBe('blocked');expect(fixture.retryGoal).not.toHaveBeenCalled();
  expect(fixture.runGoal).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();
 });

});


describe('explicit autonomous length acceptance', () => {
 beforeEach(()=>{fixture.minChapterLength=2000;fixture.maxChapterLength=2500;});
 const delivery = (actual: number, language: 'zh'|'en' = 'zh', min = 2000, max = 2500) =>
  chapterLengthDelivery(actual, buildLengthSpec(2400, language, {minChapterLength:min, maxChapterLength:max}));
 const clean = (actual: number) => ({ reviewInputs, reviewPolicy:captureChapterReviewPolicy(fixture),
  summary:'Source-supported semantic review passed.', observations:[], delivery:delivery(actual) });
 it.each([1800,2600])('blocks retained %s characters after one failed repair, with no acceptance or next chapter', async actual => {
  const f=await setup(); f.pipeline.reviewChapter.mockResolvedValue(clean(actual) as any);
  const result=await f.runner.run(f.job,new AbortController().signal);
  expect(result.phase).toBe('blocked'); expect(result.reviewReceipt).toBeUndefined();
  expect(result.error?.code).toBe('CHAPTER_LENGTH_OUT_OF_RANGE'); expect(result.error?.message).toContain(String(actual));
  expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce(); expect(result.reviewAttempts).toBe(1); expect(result.reviewChecks).toBe(2);
  expect(f.publisher.publish).not.toHaveBeenCalled(); expect(f.pipeline.writeChapters).not.toHaveBeenCalled();
 });
 it('dispatches length-only repair without empty findings and accepts only after an independent passing review', async () => {
  const f=await setup(); f.pipeline.reviewChapter.mockResolvedValueOnce(clean(1800) as any).mockResolvedValue(clean(2200) as any);
  f.pipeline.reviseDraft.mockImplementation(async()=>{
   expect(f.store.latest('novel')?.reviewReceipt).toBeUndefined(); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  const result=await f.runner.run(f.job,new AbortController().signal);
  expect(result.phase).toBe('completed'); expect(result.reviewAttempts).toBe(1); expect(result.reviewChecks).toBe(2);
  expect(f.pipeline.reviseDraft).toHaveBeenCalledWith('novel',4,'rework',expect.stringMatching(/1800.*zh_chars.*2000.*2500/s),undefined);
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2); expect(f.publisher.publish).toHaveBeenCalledOnce();
 });
 it.each([2000,2500])('accepts the inclusive explicit boundary %s without repair', async actual => {
  const f=await setup(); f.pipeline.reviewChapter.mockResolvedValue(clean(actual) as any);
  expect((await f.runner.run(f.job,new AbortController().signal)).phase).toBe('completed');
  expect(f.pipeline.reviseDraft).not.toHaveBeenCalled(); expect(f.publisher.publish).toHaveBeenCalledOnce();
 });
 it('retains source references and the smallest semantic repair scope alongside host length measurements', async () => {
  const f=await setup(); const finding={...issue,repairScope:'surface',sourceRefs:[{sourceId:'chapter-4',quote:'Retained source quote'}]};
  f.pipeline.reviewChapter.mockResolvedValue({...clean(1800),observations:[finding]} as any);
  const result=await f.runner.run(f.job,new AbortController().signal); expect(result.phase).toBe('blocked');
  expect(f.pipeline.reviseDraft).toHaveBeenCalledWith('novel',4,'spot-fix',expect.stringContaining('1800'),{reviewFindings:[finding]});
  expect(f.publisher.publish).not.toHaveBeenCalled();
 });
 it.each(['foundation','unavailable','state','scope'] as const)('does not use length failure to override %s blocking evidence', async kind => {
  const f=await setup();const finding=kind==='foundation'?{...issue,repairScope:'foundation'}:
   kind==='unavailable'?{...issue,assessment:'unavailable'}:
   kind==='scope'?{...issue,category:'scope',code:'CHAPTER_EDIT_SCOPE_CONFLICT'}:{...issue,code:'state-sync-required'};
  f.pipeline.reviewChapter.mockResolvedValue({...clean(1800),observations:[finding]} as any);
  await f.runner.run(f.job,new AbortController().signal);
  expect(f.pipeline.reviseDraft).not.toHaveBeenCalled();expect(f.publisher.publish).not.toHaveBeenCalled();
 });
 it('retains a failed length repair budget across store reopen and bounds subsequent audits', async () => {
  const f=await setup();f.pipeline.reviewChapter.mockResolvedValue(clean(1800) as any);
  f.pipeline.reviseDraft.mockRejectedValue(new Error('Synthetic correction failed'));
  const first=await f.runner.run(f.job,new AbortController().signal);expect(first.phase).toBe('blocked');expect(first.error?.message).toContain('1800');expect(first.reviewAttempts).toBe(1);expect(first.reviewReceipt).toBeUndefined();
  f.store.close();stores.splice(stores.indexOf(f.store),1);const reopened=new SchedulerStore(join(f.root,'harness.sqlite'));stores.push(reopened);
  const restarted=new AutonomousChapterRunner(f.root,f.pipeline as any,reopened,{publisher:f.publisher,retryDelayMs:1,now:()=>Date.now()+100000});
  mockRetainedRevision(restarted).mockResolvedValue({revisionId:'revision-4',observations:[]});
  const blocked=await restarted.run(reopened.latest('novel')!,new AbortController().signal);
  expect(blocked.phase).toBe('blocked');expect(blocked.reviewAttempts).toBe(1);expect(blocked.reviewChecks).toBe(1);
  await restarted.run(blocked,new AbortController().signal);expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce();
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(f.publisher.publish).not.toHaveBeenCalled();expect(f.pipeline.writeChapters).not.toHaveBeenCalled();
 });
 it('reopens an interrupted reviewing repair with its existing length budget before independently auditing again', async()=>{
  const f=await setup(),controller=new AbortController();f.pipeline.reviewChapter.mockResolvedValue(clean(1800) as any);
  f.pipeline.reviseDraft.mockImplementation(async()=>{controller.abort(new Error('Synthetic interrupted repair'));throw controller.signal.reason;});
  const interrupted=await f.runner.run(f.job,controller.signal);
  expect(interrupted).toMatchObject({phase:'reviewing',reviewAttempts:1,reviewChecks:1,reviewRepair:{revisionId:'revision-4'}});
  expect(interrupted.reviewReceipt).toBeUndefined();
  f.store.close();stores.splice(stores.indexOf(f.store),1);const reopened=new SchedulerStore(join(f.root,'harness.sqlite'));stores.push(reopened);
  const restarted=new AutonomousChapterRunner(f.root,f.pipeline as any,reopened,{publisher:f.publisher,retryDelayMs:1,now:()=>Date.now()+100000});
  mockRetainedRevision(restarted).mockResolvedValue({revisionId:'revision-4',observations:[]});
  const result=await restarted.run(reopened.latest('novel')!,new AbortController().signal);
  expect(result).toMatchObject({phase:'blocked',reviewAttempts:1,reviewChecks:2,error:{code:'CHAPTER_LENGTH_OUT_OF_RANGE'}});
  expect(result.reviewReceipt).toBeUndefined();expect(f.pipeline.reviseDraft).toHaveBeenCalledOnce();
  expect(f.pipeline.reviewChapter).toHaveBeenCalledTimes(2);expect(f.publisher.publish).not.toHaveBeenCalled();expect(f.pipeline.writeChapters).not.toHaveBeenCalled();
 });
 it.each(['pause','cancel'] as const)('respects %s during a length repair and leaves the receipt absent', async kind => {
  const f=await setup(),controller=new AbortController();f.pipeline.reviewChapter.mockResolvedValue(clean(1800) as any);
  f.pipeline.reviseDraft.mockImplementation(async()=>{if(kind==='pause')fixture.status='paused';else controller.abort(new Error('Synthetic cancel'));});
  const result=await f.runner.run(f.job,controller.signal);expect(result.reviewAttempts).toBe(1);expect(result.reviewReceipt).toBeUndefined();
  expect(f.pipeline.reviewChapter).toHaveBeenCalledOnce();expect(f.publisher.publish).not.toHaveBeenCalled();
 });
});
