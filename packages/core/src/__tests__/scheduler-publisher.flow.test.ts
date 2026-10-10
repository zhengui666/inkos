import { readChapterReviewInputs } from "../pipeline/review-inputs.js";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../state/manager.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { PublishingStore } from '../publishing/store.js';
import { ManualPublishingAdapter } from '../publishing/manual-adapter.js';
import { createMegaNovelSchedulerPublisher, loadMegaNovelSchedulerPublisher, MegaNovelSchedulerBindingConfigurationSchema } from '../publishing/scheduler-publisher.js';
import { MegaNovelSubmissionBlockedError, type MegaNovelBrowserPort, type MegaNovelSnapshot } from '../publishing/meganovel-contracts.js';
let root:string,state:StateManager,store:PublishingStore,packages:ManualPublishingAdapter,targetId:string,revisionId:string;
let publisher:ReturnType<typeof createMegaNovelSchedulerPublisher>|undefined;
let browser:MegaNovelBrowserPort,snapshot:MegaNovelSnapshot;
const scope={sessionId:'target-1',accountId:'account-1',accountLabel:'author',remoteBookId:'remote-book'};
const sourcePath='works/book/source/chapters/0001_Scene.md';
const content='Reviewed original body.\n';
async function currentRevision(){const work=await loadWorkManifest(root,'book');const art=work.artifacts.find(a=>a.revisions.some(r=>r.id===a.currentRevisionId&&r.path==='source/chapters/0001_Scene.md'))!;return {artifactId:art.id,revisionId:art.currentRevisionId!};}
function configure(firstNewChapter=1,historicalChapterIds?:Record<number,string>){publisher=createMegaNovelSchedulerPublisher(root,[{workId:'book',targetId,scope,aiAssisted:true,firstNewChapter,historicalChapterIds,browser}]);return publisher;}
const signal=()=>new AbortController().signal;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'inkos-publisher-bridge-'));state=new StateManager(root);const now=new Date().toISOString();await state.saveBookConfig('book',{id:'book',title:'Novel',platform:'meganovel',genre:'fantasy',status:'active',targetChapters:24,chapterWordCount:2000,language:'en',createdAt:now,updatedAt:now});await state.saveChapterIndex('book',[{number:1,title:'Scene',wordCount:3,provenance:'generated',observations:[],createdAt:now,updatedAt:now}]);await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:sourcePath,content}]});store=new PublishingStore(join(root,'.inkos/harness.sqlite'));packages=new ManualPublishingAdapter(root,store);targetId=(await packages.mapBook({workId:'book',platform:'meganovel',accountLabel:scope.accountLabel,remoteBookId:scope.remoteBookId})).id;revisionId=(await currentRevision()).revisionId;snapshot={scope,origin:'https://www.meganovel.com',blocker:'none',chapterNumber:1,complete:true,candidates:[]};browser={probe:vi.fn(async()=>({scope,origin:'https://www.meganovel.com' as const,blocker:'none' as const})),snapshot:vi.fn(async()=>structuredClone(snapshot)),createDraft:vi.fn(async input=>{snapshot.candidates=[{remoteChapterId:'remote-1',number:1,title:input.title,content:input.content,status:'draft',aiDisclosure:'declared_ai',evidence:'Synthetic reopened detail'}];}),submit:vi.fn(async()=>{snapshot.candidates[0].status='reviewing';})};});
afterEach(async()=>{vi.restoreAllMocks();await publisher?.close();publisher=undefined;store.close();await rm(root,{recursive:true,force:true});});
describe('scheduler publishing wrapper with retained real packages and synthetic remote port',()=>{
 it.each(['submitted', 'reviewing', 'published', 'rejected'] as const)(
  'blocks new writing when previously observed %s history disappears and recovers only through matching readback', async status => {
  const p = configure(2);
  snapshot.candidates = [{remoteChapterId:'remote-1',number:1,title:'Scene',content,status,
   aiDisclosure:'declared_ai',evidence:'Synthetic independently reopened chapter detail'}];
  if (status === 'published') await expect(p.ready('book', signal())).resolves.toBeUndefined();
  else await expect(p.ready('book', signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  const pkg = store.listPackages(targetId)[0];
  const retained = store.getMegaNovelRun(pkg.manifest.id, 1);
  await p.close(); publisher = undefined;
  const reopened = configure(2);
  snapshot.candidates = [];
  for (let attempt = 0; attempt < 2; attempt++) {
   await expect(reopened.ready('book', signal())).rejects.toMatchObject({code:'MEGANOVEL_READBACK_REQUIRED'});
   await expect(reopened.reconcile!({workId:'book',chapterNumber:1,signal:signal()}))
    .rejects.toMatchObject({code:'MEGANOVEL_READBACK_REQUIRED'});
   await expect(reopened.publish({workId:'book',chapterNumber:1,revisionId,
    reviewInputs:await readChapterReviewInputs(state.bookDir('book'),1),signal:signal()}))
    .rejects.toMatchObject({code:'MEGANOVEL_READBACK_REQUIRED'});
   expect(store.getMegaNovelRun(pkg.manifest.id, 1)).toEqual(retained);
   expect(store.listPackages(targetId)).toEqual([pkg]);
  }
  for (const conflict of [{remoteChapterId:'other-id'}, {content:'different body'}]) {
   snapshot.candidates = [{remoteChapterId:'remote-1',number:1,title:'Scene',content,status,
    aiDisclosure:'declared_ai',evidence:'Synthetic conflicting detail',...conflict}];
   await expect(reopened.ready('book', signal())).rejects.toMatchObject({code:'MEGANOVEL_CONTENT_CONFLICT'});
   expect(store.getMegaNovelRun(pkg.manifest.id, 1)).toEqual(retained);
  }
  const evidence = 'Synthetic independently reopened matching detail';
  snapshot.candidates = [{remoteChapterId:'remote-1',number:1,title:'Scene',content,status,aiDisclosure:'declared_ai',evidence}];
  if (status === 'published') await expect(reopened.ready('book', signal())).resolves.toBeUndefined();
  else await expect(reopened.ready('book', signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  expect(store.getMegaNovelRun(pkg.manifest.id, 1)).toEqual({...retained,evidence});
  expect(store.listPackages(targetId)).toHaveLength(1);
  expect(browser.createDraft).not.toHaveBeenCalled();
  expect(browser.submit).not.toHaveBeenCalled();
 });
 it('does not repeat a completed draft or submission when published readback disappears above the history boundary', async () => {
  const p = configure(1);
  const input = {workId:'book',chapterNumber:1,revisionId,
   reviewInputs:await readChapterReviewInputs(state.bookDir('book'),1),signal:signal()};
  await p.publish(input);
  snapshot.candidates[0].status = 'published';
  expect((await p.publish(input)).status).toBe('published');
  const observed = structuredClone(snapshot.candidates);
  const pkg = store.listPackages(targetId)[0];
  const retained = store.getMegaNovelRun(pkg.manifest.id, 1);
  snapshot.candidates = [];
  await expect(p.ready('book', signal())).rejects.toMatchObject({code:'MEGANOVEL_READBACK_REQUIRED'});
  await expect(p.publish(input)).rejects.toMatchObject({code:'MEGANOVEL_READBACK_REQUIRED'});
  expect(store.getMegaNovelRun(pkg.manifest.id, 1)).toEqual(retained);
  expect(store.listPackages(targetId)).toEqual([pkg]);
  snapshot.candidates = observed;
  await expect(p.ready('book', signal())).resolves.toBeUndefined();
  expect((await p.publish(input)).status).toBe('published');
  expect(browser.createDraft).toHaveBeenCalledOnce();
  expect(browser.submit).toHaveBeenCalledOnce();
 });
 it('freezes TXT, sends once, and distinguishes review from publication across invocations',async()=>{const p=configure();await p.ready('book',signal());expect((await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()})).status).toBe('submitted');expect(store.listPackages(targetId)[0].manifest.formats).toEqual(['txt']);snapshot.candidates[0].status='published';expect((await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()})).status).toBe('published');expect(browser.createDraft).toHaveBeenCalledOnce();expect(browser.submit).toHaveBeenCalledOnce();});
 it('keeps an unknown submission across wrapper recreation without resending',async()=>{browser.submit=vi.fn(async()=>{throw new Error('response lost');});let p=configure();expect((await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()})).status).toBe('pending');await p.close();publisher=undefined;p=configure();await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()});expect(browser.createDraft).toHaveBeenCalledOnce();expect(browser.submit).toHaveBeenCalledOnce();});
 it('historical chapters are readback-only even when no remote row is visible',async()=>{const p=configure(2);await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();const pkg=store.listPackages(targetId)[0];expect(store.getMegaNovelRun(pkg.manifest.id,1)?.phase).toBe('draft_unknown');snapshot.candidates=[{remoteChapterId:'remote-1',number:1,title:'Scene',content,status:'published',aiDisclosure:'declared_ai',evidence:'Synthetic independently reopened published detail'}];await expect(p.ready('book',signal())).resolves.toBeUndefined();expect(browser.createDraft).not.toHaveBeenCalled();});
 it('reconciles the original manual unknown package rather than uploading a fresh copy',async()=>{const selected=await currentRevision();const pkg=await packages.prepare({targetId,chapters:[{...selected,number:1,title:'Scene'}],formats:['txt']});await packages.beginSubmission({packageId:pkg.manifest.id,chapterNumber:1,expectedVersion:0,eventId:'old-manual'});const p=configure();await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()});expect(store.listPackages(targetId)).toHaveLength(1);expect(store.getMegaNovelRun(pkg.manifest.id,1)?.phase).toBe('submit_unknown');expect(browser.createDraft).not.toHaveBeenCalled();});
 it('rejects a different current revision before freezing or touching the remote editor',async()=>{const p=configure();await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:sourcePath,content:'An edited retained body.\n'}]});await expect(p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()})).rejects.toMatchObject({code:'CHAPTER_REVISION_CHANGED'});expect(store.listPackages(targetId)).toHaveLength(0);expect(browser.createDraft).not.toHaveBeenCalled();});
 it('preserves unregistered source edits without silently freezing stale content',async()=>{const p=configure();await writeFile(join(root,sourcePath),'Unsynchronized author edit.');await expect(p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()})).rejects.toMatchObject({code:'CHAPTER_REVISION_CHANGED'});expect(browser.createDraft).not.toHaveBeenCalled();});
 it.each(['registered-revision', 'unregistered-body', 'frozen-manifest', 'frozen-payload'] as const)(
  'rejects a late %s change at synchronous final authorization without replacing the retained draft', async change => {
  const p = configure();
  const input = {workId:'book',chapterNumber:1,revisionId,
   reviewInputs:await readChapterReviewInputs(state.bookDir('book'),1),signal:signal()};
  const submitEffect = vi.fn(() => { snapshot.candidates[0]!.status = 'reviewing'; });
  let retainedManifest: ReturnType<PublishingStore['getPackage']>['manifest'] | undefined;
  let mutatedSource: string | undefined;
  let finalAuthorizations = 0;
  browser.submit = vi.fn<MegaNovelBrowserPort['submit']>(async (request, options) => {
   expect(options?.beforeMutation).toBeTypeOf('function');
   expect(options?.authorizeSubmission).toBeTypeOf('function');
   await options!.beforeMutation!();
   const pkg = store.getPackage(request.packageId);
   retainedManifest = structuredClone(pkg.manifest);
   expect(store.getMegaNovelRun(request.packageId,1)).toMatchObject({phase:'submit_unknown',revisionId,remoteChapterId:'remote-1'});
   expect(request).toMatchObject({revisionId,remoteChapterId:'remote-1',title:'Scene',content});
   const directory = join(root,'.inkos','publishing',request.packageId);
   const selected = pkg.manifest.chapters.find(chapter => chapter.number === 1)!;
   // The async guard has completed; independently change one dispatch authority
   // before the binding issues its synchronous final authorization and effect.
   if (change === 'registered-revision') {
    mutatedSource = 'The author registered a later chapter body before final submission.\n';
    await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:sourcePath,content:mutatedSource}]});
    expect((await currentRevision()).revisionId).not.toBe(revisionId);
   } else if (change === 'unregistered-body') {
    mutatedSource = 'An unregistered author edit arrived before final submission.\n';
    await writeFile(join(root,sourcePath),mutatedSource);
    expect((await currentRevision()).revisionId).toBe(revisionId);
   } else if (change === 'frozen-manifest') {
    await writeFile(join(directory,'manifest.json'),JSON.stringify({...pkg.manifest,
     chapters:pkg.manifest.chapters.map(chapter => ({...chapter,sourcePath:'source/chapters/0001_Different.md'}))}));
   } else {
    await writeFile(join(directory,selected.packagePath),'A changed frozen package payload must never be dispatched.\n');
   }
   try {
    finalAuthorizations++;
    expect(options!.authorizeSubmission!(request)).toBeUndefined();
   } catch (error) {
    // This port knows no submission effect has been invoked in this request.
    throw new MegaNovelSubmissionBlockedError(error);
   }
   submitEffect();
  });
  const failure = await p.publish(input).catch(error => error);
  expect(finalAuthorizations).toBe(1);
  expect(submitEffect).not.toHaveBeenCalled();
  expect(failure).toMatchObject({code:change.startsWith('frozen-') ? 'PUBLISHING_PACKAGE_INTEGRITY' : 'CHAPTER_REVISION_CHANGED'});
  expect(retainedManifest).toBeDefined();
  const pkg = store.getPackage(retainedManifest!.id);
  const draft = store.getMegaNovelRun(pkg.manifest.id,1)!;
  expect(pkg.manifest).toEqual(retainedManifest);
  expect(draft).toMatchObject({packageId:pkg.manifest.id,phase:'draft',revisionId,remoteChapterId:'remote-1'});
  expect(snapshot.candidates).toEqual([{remoteChapterId:'remote-1',number:1,title:'Scene',content,
   status:'draft',aiDisclosure:'declared_ai',evidence:'Synthetic reopened detail'}]);
  if (mutatedSource !== undefined) expect(await readFile(join(root,sourcePath),'utf8')).toBe(mutatedSource);
  await p.close(); publisher = undefined;
  const reopened = configure();
  await expect(reopened.publish({...input,signal:signal()})).rejects.toMatchObject({
   code:change.startsWith('frozen-') ? 'PUBLISHING_PACKAGE_INTEGRITY' : 'CHAPTER_REVISION_CHANGED'});
  expect(store.listPackages(targetId)).toHaveLength(1);
  expect(store.getPackage(pkg.manifest.id).manifest).toEqual(retainedManifest);
  expect(store.getMegaNovelRun(pkg.manifest.id,1)).toEqual(draft);
  expect(browser.createDraft).toHaveBeenCalledOnce();
  expect(browser.submit).toHaveBeenCalledOnce();
  expect(submitEffect).not.toHaveBeenCalled();
 });
 it('rejects changed actual dispatch body while current source, snapshot and frozen package still contain the reviewed body', async () => {
  const p = configure();
  const submitEffect = vi.fn((_request: Parameters<MegaNovelBrowserPort['submit']>[0]) => {
   snapshot.candidates[0]!.status = 'reviewing';
  });
  let retainedManifest: ReturnType<PublishingStore['getPackage']>['manifest'] | undefined;
  let authorizedPayload: Parameters<MegaNovelBrowserPort['submit']>[0] | undefined;
  browser.submit = vi.fn<MegaNovelBrowserPort['submit']>(async (request, options) => {
   await options!.beforeMutation!();
   const pkg = store.getPackage(request.packageId);
   retainedManifest = structuredClone(pkg.manifest);
   const selected = pkg.manifest.chapters.find(chapter => chapter.number === 1)!;
   const work = await loadWorkManifest(root,'book');
   const revision = work.artifacts.find(artifact => artifact.id === selected.artifactId)!.revisions
    .find(item => item.id === revisionId)!;
   expect((await currentRevision()).revisionId).toBe(revisionId);
   expect(await readFile(join(root,sourcePath),'utf8')).toBe(content);
   expect(await readFile(join(root,'works','book',revision.snapshotPath!),'utf8')).toBe(content);
   expect(await readFile(join(root,'.inkos','publishing',request.packageId,selected.packagePath),'utf8')).toBe(content);
   expect(request.content).toBe(content);
   authorizedPayload = {...request,content:'A substituted dispatch body that was never reviewed or frozen.\n'};
   try {
    expect(options!.authorizeSubmission!(authorizedPayload)).toBeUndefined();
   } catch (error) { throw new MegaNovelSubmissionBlockedError(error); }
   submitEffect(authorizedPayload);
  });
  const failure = await p.publish({workId:'book',chapterNumber:1,revisionId,
   reviewInputs:await readChapterReviewInputs(state.bookDir('book'),1),signal:signal()}).catch(error => error);
  expect(authorizedPayload?.content).not.toBe(content);
  expect(submitEffect).not.toHaveBeenCalled();
  expect(failure).toMatchObject({code:'PUBLISHING_PACKAGE_INTEGRITY'});
  expect(store.listPackages(targetId)).toHaveLength(1);
  expect(store.getPackage(retainedManifest!.id).manifest).toEqual(retainedManifest);
  expect(store.getMegaNovelRun(retainedManifest!.id,1)).toMatchObject({
   packageId:retainedManifest!.id,phase:'draft',revisionId,remoteChapterId:'remote-1'});
  expect(snapshot.candidates).toEqual([{remoteChapterId:'remote-1',number:1,title:'Scene',content,
   status:'draft',aiDisclosure:'declared_ai',evidence:'Synthetic reopened detail'}]);
  expect(browser.createDraft).toHaveBeenCalledOnce();
  expect(browser.submit).toHaveBeenCalledOnce();
 });
 it('reads an older uncertain package without submitting a newly reviewed revision',async()=>{browser.createDraft=vi.fn(async()=>{throw new Error('unknown autosave');});const p=configure();await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()});await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:sourcePath,content:'Edited after uncertain upload.\n'}]});const newer=(await currentRevision()).revisionId;await expect(p.publish({workId:'book',chapterNumber:1,revisionId:newer,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()})).resolves.toMatchObject({status:'pending'});expect(browser.createDraft).toHaveBeenCalledOnce();expect(store.listPackages(targetId)).toHaveLength(1);});
 it('uses known historical chapter identities for direct readback without claiming publication',async()=>{const p=configure(2,{1:'known-remote-1'});await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});expect(browser.snapshot).toHaveBeenCalledWith(expect.objectContaining({remoteChapterId:'known-remote-1',expectedTitle:'Scene'}),expect.objectContaining({signal:expect.any(AbortSignal)}));const pkg=store.listPackages(targetId)[0];expect(store.getMegaNovelRun(pkg.manifest.id,1)).toMatchObject({phase:'submit_unknown',remoteChapterId:'known-remote-1'});expect(browser.createDraft).not.toHaveBeenCalled();});
 it('blocks next-chapter admission on all retained manual attempts even above the configured history boundary',async()=>{
  const selected=await currentRevision();const pkg=await packages.prepare({targetId,chapters:[{...selected,number:1,title:'Scene'}],formats:['txt']});
  await packages.beginSubmission({packageId:pkg.manifest.id,chapterNumber:1,expectedVersion:0,eventId:'manual-beyond-boundary'});
  const p=configure(1);await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  expect(browser.snapshot).toHaveBeenCalledOnce();expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();
 });
 it('lets the current publishing stage reconcile its own pending draft without blocking itself',async()=>{
  browser.submit=vi.fn(async()=>{throw new Error('uncertain submit');});const p=configure(1);
  await p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:signal()});
  await expect(p.ready('book',signal(),1)).resolves.toBeUndefined();
  await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  expect(browser.submit).toHaveBeenCalledOnce();
 });
 it('requires the exact configured canonical replay receipt before browser access or new writing',async()=>{
  publisher=createMegaNovelSchedulerPublisher(root,[{workId:'book',targetId,scope,aiAssisted:true,firstNewChapter:2,
    requiredStateReplay:{chapterNumber:1,planId:'required-reviewed-plan'},browser}]);
  await expect(publisher.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_CANONICAL_REPLAY_REQUIRED'});
  expect(browser.probe).not.toHaveBeenCalled();
  const dir=join(state.bookDir('book'),'story','runtime');await mkdir(dir,{recursive:true});
  const receipt=join(dir,'chapter-0001.state-replay.json');
  await writeFile(receipt,JSON.stringify({planId:'older-plan',chapterNumber:1,validation:{consistent:true,reconciliationRequired:false}}));
  await expect(publisher.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_CANONICAL_REPLAY_REQUIRED'});
  await writeFile(receipt,JSON.stringify({planId:'required-reviewed-plan',chapterNumber:1,validation:{consistent:true,reconciliationRequired:false}}));
  await expect(publisher.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  expect(browser.probe).toHaveBeenCalledOnce();expect(browser.createDraft).not.toHaveBeenCalled();
 });
 it('rejects history boundary mistakes in the programmatic API before opening its store',()=>{
   expect(()=>configure(1,{1:'already-known'})).toThrow();
   expect(()=>configure(3,{1:'duplicate',2:'duplicate'})).toThrow();
 });
 it('uses an observed historical ID to read back the original manual unknown package without an old receipt ID',async()=>{
  const selected=await currentRevision();const pkg=await packages.prepare({targetId,chapters:[{...selected,number:1,title:'Scene'}],formats:['txt']});
  await packages.beginSubmission({packageId:pkg.manifest.id,chapterNumber:1,expectedVersion:0,eventId:'old-manual-no-id'});
  const p=configure(2,{1:'known-remote-1'});
  await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  expect(store.listPackages(targetId)).toHaveLength(1);
  expect(store.getMegaNovelRun(pkg.manifest.id,1)).toMatchObject({phase:'submit_unknown',remoteChapterId:'known-remote-1'});
  expect(browser.snapshot).toHaveBeenCalledWith(expect.objectContaining({remoteChapterId:'known-remote-1'}),expect.any(Object));
  expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();
 });
 it('does not begin a remote mutation if stop arrives during package preparation',async()=>{const p=configure(),controller=new AbortController();const original=StateManager.prototype.acquireBookLock;vi.spyOn(StateManager.prototype,'acquireBookLock').mockImplementationOnce(async function(this:StateManager,id:string){const release=await original.call(this,id);controller.abort(new Error('stop during freeze'));return release;});await expect(p.publish({workId:'book',chapterNumber:1,revisionId,reviewInputs:await readChapterReviewInputs(state.bookDir("book"),1),signal:controller.signal})).rejects.toThrow('stop during freeze');expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();});

});


describe('native MegaNovel scheduler deployment configuration', () => {
  const configuration = () => ({
    workId: 'book', targetId, firstNewChapter: 2, aiAssisted: true, scope,
    endpointURL: 'http://127.0.0.1:9222', lockDirectory: join(root, 'browser-locks'),
    authorization: {
      automation: {provenance: 'user_reported' as const, reference: 'Fixture automation permission'},
      aiAssistedContent: {provenance: 'user_reported' as const, reference: 'Fixture truthful AI permission'},
    },
    dom: {knownChapters: [{number: 1, title: 'Scene', remoteChapterId: '101',
      publicUrl: 'https://www.meganovel.com/story/Fixture_99/Scene_101'}]},
  });
  it('supports the native DOM configuration without an external bootstrap module', () => {
    expect(MegaNovelSchedulerBindingConfigurationSchema.parse(configuration()).domBindingModule).toBeUndefined();
  });
  it('rejects conflicting DOM and migration identities before any connection', () => {
    expect(() => MegaNovelSchedulerBindingConfigurationSchema.parse({...configuration(), historicalChapterIds: {'1': 'different'}})).toThrow();
    expect(() => MegaNovelSchedulerBindingConfigurationSchema.parse({...configuration(), firstNewChapter: 1})).toThrow();
    expect(() => MegaNovelSchedulerBindingConfigurationSchema.parse({...configuration(), dom: undefined, historicalChapterIds: {'2': 'known-at-boundary'}})).toThrow();
    expect(() => MegaNovelSchedulerBindingConfigurationSchema.parse({...configuration(), domBindingModule: 'custom.mjs'})).toThrow();
  });
  it('wires the built-in binding, keeps private DOM options out of transport and adopts known IDs read-only', async () => {
    const connect = vi.fn(async (_configuration: unknown, _binding: unknown) => browser);
    vi.doMock('../publishing/meganovel-cdp.js', () => ({connectMegaNovelCdpPort: connect}));
    try {
      const path = join(root, 'publish-fixture.json');
      await writeFile(path, JSON.stringify([configuration()]));
      publisher = await loadMegaNovelSchedulerPublisher(root, path);
      expect(connect).toHaveBeenCalledOnce();
      expect(connect.mock.calls[0]![0]).not.toHaveProperty('dom');
      expect(connect.mock.calls[0]![1]).toMatchObject({protocol: 'inkos-meganovel-dom-v1', snapshot: expect.any(Function)});
      await expect(publisher.ready('book', signal())).rejects.toMatchObject({code: 'PUBLISHING_HISTORY_PENDING'});
      expect(browser.snapshot).toHaveBeenCalledWith(expect.objectContaining({remoteChapterId: '101'}), expect.any(Object));
      expect(browser.createDraft).not.toHaveBeenCalled();
      expect(browser.submit).not.toHaveBeenCalled();
    } finally { vi.doUnmock('../publishing/meganovel-cdp.js'); }
  });
});
