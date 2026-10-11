import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it as test, vi } from 'vitest';
import { CodexRuntimeFixtureScope } from './fixtures/codex-runtime-fixture.js';
import { DrainedTestScope } from './fixtures/drained-test-scope.js';
import { ChapterGoalService, chapterGoalView } from '../goals/service.js';
import { StateManager } from '../state/manager.js';
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from '../harness/work-store.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { createInitialRuntimeState, buildRuntimeStateArtifacts, loadRuntimeStateSnapshot } from '../state/runtime-state-store.js';
import { PipelineRunner } from '../pipeline/runner.js';
import { persistChapterArtifacts } from '../pipeline/chapter-persistence.js';
import { PlannerAgent } from '../agents/planner.js';
import { WriterAgent, type WriteChapterOutput } from '../agents/writer.js';
import { ContinuityAuditor } from '../agents/continuity.js';
import { StateValidatorAgent } from '../agents/state-validator.js';
import { createLLMClient } from '../llm/provider.js';
import { withExecutionEvidence, currentExecutionAuthorRequest, recordExecutionEvidence } from '../harness/execution-evidence.js';
import { createChapterGoalTools } from '../harness/tools/chapter-goals.js';
import { createProductionCapabilityRegistry } from '../harness/production-capabilities.js';
import { createBuiltInWorkProfileRegistry } from '../harness/builtin-profiles.js';
import { CreativeEpisodeStore } from '../harness/episode-store.js';
import { CreativeHarnessRuntime } from '../harness/runtime.js';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('../codex/client.js', () => ({ createCodexClient: mocks.createClient }));
type WatchedChild = { child: ChildProcess; ready: Promise<void>; closed: Promise<void> };
const roots: string[] = [], services: ChapterGoalService[] = [], episodeStores: CreativeEpisodeStore[] = [];
const children: WatchedChild[] = [], releases = new Set<() => void>();
let scope: CodexRuntimeFixtureScope, testScope: DrainedTestScope;
function it(name: string, body: () => Promise<void>, timeout?: number) {
  test(name, () => testScope.run(body), timeout);
}
function runOwned<T>(task: () => Promise<T>) { return scope.run(() => task()); }
async function drainWriterWork(writerWork: readonly Promise<unknown>[]) {
  const failures: unknown[] = [];
  for (const result of await Promise.allSettled(writerWork)) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Late writer output work failed.');
}
beforeEach(() => {
  vi.stubEnv('INKOS_CODEX_HOME', undefined);
  vi.stubEnv('INKOS_CODEX_STATE_ROOT', undefined);
  scope = new CodexRuntimeFixtureScope(); testScope = new DrainedTestScope();
  mocks.createClient.mockReset().mockImplementation(scope.createClient);
});
afterEach(async () => {
  for (const release of releases) release();
  releases.clear();
  for (const watched of children.splice(0)) {
    if (watched.child.exitCode === null && watched.child.signalCode === null) watched.child.kill();
    await watched.closed; await Promise.allSettled([watched.ready]);
  }
  await testScope.drain();
  try { await scope.drain(); }
  finally {
    for (const store of episodeStores.splice(0)) store.close();
    for (const service of services.splice(0)) service.close();
    mocks.createClient.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true})));
  }
});
function watchChild(child: ChildProcess): WatchedChild {
  let stdout = '', stderr = '', readySeen = false;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.split(/\r?\n/).includes('ready')) { readySeen = true; resolve(); }
    });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const fail = (message: string) => { void closed.then(() => reject(new Error(`${message}\nstderr:\n${stderr}`))); };
    child.once('error', error => fail(`GoalStore child errored before ready: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (!readySeen) fail(`GoalStore child exited before ready (code=${code}, signal=${signal})`);
    });
  });
  const watched = { child, ready, closed }; children.push(watched); return watched;
}
async function setup(endChapter=2) {
  const root=await mkdtemp(join(tmpdir(),'inkos-goal-entry-'));roots.push(root);
  scope.registerProject(root);
  const state=new StateManager(root),bookDir=state.bookDir('novel'),now=new Date().toISOString();
  await saveWorkManifest(root,createWorkManifest({id:'novel',title:'Departure',profileId:'longform-novel',language:'en'}));
  await state.saveBookConfig('novel',{id:'novel',title:'Departure',genre:'general',platform:'other',status:'active',targetChapters:endChapter,chapterWordCount:10,language:'en',createdAt:now,updatedAt:now});
  await mkdir(join(bookDir,'story/outline'),{recursive:true});
  for(const [path,body] of Object.entries({'outline/story_frame.md':'A witness leaves.','outline/volume_map.md':'Departure scenes.','book_rules.md':'Preserve facts.','book_rules.json':JSON.stringify({version:'2',prohibitions:[],enableFullCastTracking:false,allowedDeviations:[]})}))await writeFile(join(bookDir,'story',path),body);
  await createInitialRuntimeState({bookDir,language:'en'});await state.saveChapterIndex('novel',[]);await state.snapshotState('novel',0);
  const client=createLLMClient({service:'custom',provider:'openai',configSource:'studio',model:'fixture',apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',apiFormat:'chat',stream:false,temperature:0,thinkingBudget:0});
  const pipeline=new PipelineRunner({projectRoot:root,client,model:'fixture'});
  vi.spyOn(PlannerAgent.prototype,'planChapter').mockImplementation(async input=>({intent:{chapter:input.chapterNumber,goal:input.externalContext??'Continue'},memo:{chapter:input.chapterNumber,goal:'Continue',body:'Continue the departure',threadRefs:[]},intentMarkdown:'Continue the departure',runtimePath:`runtime/chapter-${input.chapterNumber}.intent.md`,plannerInputs:[]}));
  const contextSeen: string[]=[];
  const write=vi.spyOn(WriterAgent.prototype,'writeChapter').mockImplementation(input=>{contextSeen.push(currentExecutionAuthorRequest()??'');recordExecutionEvidence('fixture-goal-worker',{chapter:input.chapterNumber});return output(bookDir,input.chapterNumber);});
  vi.spyOn(ContinuityAuditor.prototype,'auditChapter').mockResolvedValue({summary:'',observations:[]});
  vi.spyOn(StateValidatorAgent.prototype,'validate').mockResolvedValue({consistent:true,reconciliationRequired:false,observations:[]});
  const writer=new WriterAgent({client,model:'fixture',projectRoot:root});
  const save=async(chapter:number)=>{const value=await output(bookDir,chapter);await persistChapterArtifacts({chapterNumber:chapter,chapterTitle:value.title,auditResult:{summary:'',observations:[]},finalWordCount:value.wordCount,loadChapterIndex:()=>state.loadChapterIndex('novel'),saveChapter:index=>writer.saveChapter(bookDir,value,'en',index),markBookActiveIfNeeded:async()=>undefined});};
  const factory=vi.fn(()=>pipeline),service=new ChapterGoalService({projectRoot:root,createPipeline:factory});services.push(service);
  const input={id:'goal',workId:'novel',intent:'Finish this fixed departure sequence.',startChapter:1,endChapter,expiresAt:Date.now()+120000};
  return {root,state,bookDir,pipeline,write,save,factory,service,input,contextSeen};
}
async function output(bookDir:string,chapter:number):Promise<WriteChapterOutput>{
  const artifacts=await buildRuntimeStateArtifacts({bookDir,language:'en',delta:{chapter,factOps:{upsert:[{subject:'witness',predicate:'location',object:`door ${chapter}`}],expire:[]},hookOps:{upsert:[],mention:[],resolve:[],defer:[]},newHookCandidates:[],chapterSummary:{chapter,title:`Departure ${chapter}`,characters:'witness',events:'The witness leaves.',stateChanges:'Another door.',hookActivity:'',mood:'tense',chapterType:'investigation'}}});
  return {chapterNumber:chapter,title:`Departure ${chapter}`,content:'The witness closes the ledger and leaves the room.',wordCount:10,postSettlement:'',runtimeStateDelta:artifacts.resolvedDelta,runtimeStateSnapshot:artifacts.snapshot,updatedState:artifacts.currentStateMarkdown,updatedHooks:artifacts.hooksMarkdown,updatedChapterSummaries:artifacts.chapterSummariesMarkdown,runtimeStateApplied:true};
}

describe('public persistent chapter goal entry points',()=>{
  it('creates idempotently, scopes reads and controls, and queries without a runtime',async()=>{
    const f=await setup(),first=await f.service.create(f.input);
    expect(first).toMatchObject({status:'paused',desiredState:'paused',attempts:0});
    expect(await f.service.create(f.input)).toEqual(first);
    await expect(f.service.create({...f.input,intent:'Different scope'})).rejects.toMatchObject({code:'GOAL_ID_CONFLICT'});
    expect(f.service.list('novel')).toEqual([first]);expect(f.service.list('other')).toEqual([]);
    expect(()=>f.service.get('goal','other')).toThrowError(expect.objectContaining({code:'GOAL_WORK_SCOPE_MISMATCH'}));
    expect(()=>f.service.stop('goal','paused',999)).toThrowError(expect.objectContaining({code:'GOAL_VERSION_CONFLICT'}));
    expect(()=>f.service.recover('goal',999)).toThrowError(expect.objectContaining({code:'GOAL_VERSION_CONFLICT'}));
    const page=f.service.events('goal',{limit:1});expect(page.events).toHaveLength(1);expect(page.nextAfterSeq).toBe(0);
    expect(f.service.events('goal',{afterSeq:page.nextAfterSeq}).events).toEqual([]);
    expect(f.service.recover('goal',first.version)).toEqual(first);
    expect(f.factory).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
  });

  it('runs only chapter 18 after 1–17 exist and preserves authority/evidence and completed no-op semantics',async()=>{
    const f=await setup(18);for(let chapter=1;chapter<=17;chapter++)await f.save(chapter);
    await syncWorkSourceArtifacts({projectRoot:f.root,workId:'novel',accept:true});
    const before=await Promise.all(Array.from({length:17},(_,i)=>readFile(join(f.bookDir,`chapters/${String(i+1).padStart(4,'0')}_Departure_${i+1}.md`))));
    const created=await f.service.create(f.input),evidence:string[]=[];
    const done=await withExecutionEvidence(type=>evidence.push(type),()=>runOwned(()=>f.service.run('goal',created.version)),undefined,undefined,'Resume the saved goal.');
    expect(done.status).toBe('completed');expect(done.attempts).toBe(1);expect(f.write.mock.calls.map(([i])=>i.chapterNumber)).toEqual([18]);
    expect(f.contextSeen).toEqual([f.input.intent]);expect(evidence).toContain('fixture-goal-worker');
    expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(18);
    for(let i=0;i<17;i++)expect(await readFile(join(f.bookDir,`chapters/${String(i+1).padStart(4,'0')}_Departure_${i+1}.md`))).toEqual(before[i]);
    expect(chapterGoalView(done)).toMatchObject({completedSteps:18,totalSteps:18,nextStepId:null,execution:'foreground'});
    expect(f.service.events('goal',{limit:200}).events.find(event=>event.type==='goal-claimed')?.payload).not.toHaveProperty('token');
    await runOwned(()=>f.service.run('goal',done.version));expect(f.factory).toHaveBeenCalledTimes(1);expect(f.write).toHaveBeenCalledTimes(1);
  },30000);

  it('recovers a dead process without inference, then explicitly continues within the same attempt budget',async()=>{
    const f=await setup(1),created=await f.service.create(f.input);
    const modulePath=new URL('../../dist/goals/store.js',import.meta.url).href;
    const script=`import {GoalStore} from ${JSON.stringify(modulePath)};const store=new GoalStore(process.argv[1]);store.requestRun('goal',store.get('goal').version);const lease=store.claim('goal');store.beginAttempt(lease,'chapter-1');process.stdout.write('ready'+String.fromCharCode(10));setInterval(()=>{store.get('goal');},1000);`;
    const child=spawn(process.execPath,['--input-type=module','-e',script,join(f.root,'.inkos/harness.sqlite')],{stdio:['ignore','pipe','pipe']});
    const watched=watchChild(child);
    try{
      await watched.ready;const running=f.service.get('goal');
      expect(running.status).toBe('running');expect(f.service.recover('goal',running.version).owner).not.toBeNull();
      expect(chapterGoalView(running).owner).not.toHaveProperty('token');
      child.kill();await watched.closed;
      const interrupted=f.service.recover('goal',running.version);expect(interrupted.status).toBe('interrupted');expect(interrupted.attempts).toBe(1);
      expect(f.factory).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
      const done=await runOwned(()=>f.service.run('goal',interrupted.version));expect(done.status).toBe('completed');expect(done.attempts).toBe(2);expect(f.write).toHaveBeenCalledTimes(1);
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await watched.closed;}
  },20000);

  it('keeps cancellation and deadline failures from initializing a runtime',async()=>{
    const f=await setup(),created=await f.service.create(f.input);
    const cancelled=f.service.stop('goal','cancelled',created.version,'novel');
    await expect(runOwned(()=>f.service.run('goal',cancelled.version))).rejects.toMatchObject({code:'GOAL_TERMINAL'});
    await expect(runOwned(()=>f.service.run('goal',cancelled.version,{workId:'other'}))).rejects.toMatchObject({code:'GOAL_WORK_SCOPE_MISMATCH'});
    await expect(f.service.create({...f.input,id:'expired',expiresAt:0})).rejects.toMatchObject({code:'GOAL_BUDGET_EXHAUSTED'});
    expect(f.factory).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
  });

  it('rejects malformed control actions without turning them into cancellation',async()=>{
    const f=await setup(),created=await f.service.create(f.input);
    const control=createChapterGoalTools(f.pipeline,f.root,'novel').find(tool=>tool.name==='control_chapter_goal')!;
    await expect(control.execute('bad-control',{goalId:'goal',expectedVersion:created.version,action:'resume'})).rejects.toMatchObject({code:'GOAL_CONTROL_INVALID'});
    expect(f.service.get('goal')).toEqual(created);expect(f.factory).not.toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
  });

  it('lets an agent persist cancellation while the goal chapter owns the Work lock',async()=>{
    const f=await setup(),work=await loadWorkManifest(f.root,'novel'),profiles=createBuiltInWorkProfileRegistry(f.root);
    const registry=createProductionCapabilityRegistry({pipeline:f.pipeline,projectRoot:f.root,sessionId:'fixture',profileId:'longform-novel',work,language:'en',playWorldExists:false,sameSessionProposal:false,allowSystemFileRead:false});
    const episodeStore=new CreativeEpisodeStore(join(f.root,'.inkos/harness.sqlite'));episodeStores.push(episodeStore);
    const runtime=new CreativeHarnessRuntime(f.root,registry,profiles,episodeStore);
    const handle=runtime.startEpisode({profileId:'longform-novel',work}),other=runtime.startEpisode({profileId:'longform-novel',work});
    let entered!:()=>void;const inWriter=new Promise<void>(resolve=>{entered=resolve;});
    let releaseWriter!:()=>void;const writerGate=new Promise<void>(resolve=>{releaseWriter=resolve;});releases.add(releaseWriter);
    const writerWork:Promise<WriteChapterOutput>[]=[];
    const lateOutputError=new Error('Synthetic late output failure.');
    await expect(drainWriterWork([Promise.reject(lateOutputError)])).rejects.toBe(lateOutputError);
    f.write.mockImplementation(async function(this: WriterAgent){
      const signal=(this as unknown as {ctx:{signal:AbortSignal}}).ctx.signal;entered();
      const waiting=writerGate.then(()=>output(f.bookDir,1));writerWork.push(waiting);
      let abort!:()=>void;
      const aborted=new Promise<WriteChapterOutput>((_,reject)=>{
        abort=()=>reject(signal.reason);
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
      });
      try{return await Promise.race([waiting,aborted]);}
      finally{signal.removeEventListener('abort',abort);}
    });
    let running:Promise<unknown>|undefined;
    let observed:Promise<{kind:'fulfilled';value:unknown}|{kind:'rejected';error:unknown}>|undefined;
    try{
      await runtime.executeAction({handle,capabilityId:'longform',actionId:'create_chapter_goal',source:'agent',confirmed:false,parameters:{goalId:'goal',intent:f.input.intent,startChapter:1,endChapter:2,expiresAt:f.input.expiresAt}});
      running=runOwned(()=>runtime.executeAction({handle,capabilityId:'longform',actionId:'run_chapter_goal',source:'agent',confirmed:false,parameters:{goalId:'goal',expectedVersion:f.service.get('goal').version}}));
      observed=running.then(value=>({kind:'fulfilled' as const,value}),error=>({kind:'rejected' as const,error}));
      const entry=await Promise.race([
        inWriter.then(()=>({kind:'writer' as const})),
        observed.then(outcome=>({kind:'settled' as const,outcome})),
      ]);
      if(entry.kind==='settled'){
        if(entry.outcome.kind==='rejected')throw entry.outcome.error;
        throw new Error(`Goal run settled before writer entry: ${JSON.stringify(entry.outcome.value)}`);
      }
      const cancel=await runOwned(()=>runtime.executeAction({handle:other,capabilityId:'longform',actionId:'control_chapter_goal',source:'agent',confirmed:false,parameters:{goalId:'goal',expectedVersion:f.service.get('goal').version,action:'cancel'}}));
      expect(cancel.status).toBe('success');await running;
      expect(f.service.get('goal')).toMatchObject({status:'cancelled',desiredState:'cancelled'});expect(f.write).toHaveBeenCalledTimes(1);
      expect(await f.state.loadChapterIndex('novel')).toEqual([]);
    }finally{
      releaseWriter();releases.delete(releaseWriter);
      await Promise.allSettled([...(running?[running]:[]),...(observed?[observed]:[])]);
      await drainWriterWork(writerWork);
    }
  },15000);
});
