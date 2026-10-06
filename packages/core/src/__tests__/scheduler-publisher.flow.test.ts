import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../state/manager.js';
import { syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { PublishingStore } from '../publishing/store.js';
import { ManualPublishingAdapter } from '../publishing/manual-adapter.js';
import { createMegaNovelSchedulerPublisher, loadMegaNovelSchedulerPublisher, MegaNovelSchedulerBindingConfigurationSchema } from '../publishing/scheduler-publisher.js';
import type { MegaNovelBrowserPort, MegaNovelSnapshot } from '../publishing/meganovel-contracts.js';
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
 it('freezes TXT, sends once, and distinguishes review from publication across invocations',async()=>{const p=configure();await p.ready('book',signal());expect((await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()})).status).toBe('submitted');expect(store.listPackages(targetId)[0].manifest.formats).toEqual(['txt']);snapshot.candidates[0].status='published';expect((await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()})).status).toBe('published');expect(browser.createDraft).toHaveBeenCalledOnce();expect(browser.submit).toHaveBeenCalledOnce();});
 it('keeps an unknown submission across wrapper recreation without resending',async()=>{browser.submit=vi.fn(async()=>{throw new Error('response lost');});let p=configure();expect((await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()})).status).toBe('pending');await p.close();publisher=undefined;p=configure();await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()});expect(browser.createDraft).toHaveBeenCalledOnce();expect(browser.submit).toHaveBeenCalledOnce();});
 it('historical chapters are readback-only even when no remote row is visible',async()=>{const p=configure(2);await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();const pkg=store.listPackages(targetId)[0];expect(store.getMegaNovelRun(pkg.manifest.id,1)?.phase).toBe('draft_unknown');snapshot.candidates=[{remoteChapterId:'remote-1',number:1,title:'Scene',content,status:'published',aiDisclosure:'declared_ai',evidence:'Synthetic independently reopened published detail'}];await expect(p.ready('book',signal())).resolves.toBeUndefined();expect(browser.createDraft).not.toHaveBeenCalled();});
 it('reconciles the original manual unknown package rather than uploading a fresh copy',async()=>{const selected=await currentRevision();const pkg=await packages.prepare({targetId,chapters:[{...selected,number:1,title:'Scene'}],formats:['txt']});await packages.beginSubmission({packageId:pkg.manifest.id,chapterNumber:1,expectedVersion:0,eventId:'old-manual'});const p=configure();await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()});expect(store.listPackages(targetId)).toHaveLength(1);expect(store.getMegaNovelRun(pkg.manifest.id,1)?.phase).toBe('submit_unknown');expect(browser.createDraft).not.toHaveBeenCalled();});
 it('rejects a different current revision before freezing or touching the remote editor',async()=>{const p=configure();await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:sourcePath,content:'An edited retained body.\n'}]});await expect(p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()})).rejects.toMatchObject({code:'CHAPTER_REVISION_CHANGED'});expect(store.listPackages(targetId)).toHaveLength(0);expect(browser.createDraft).not.toHaveBeenCalled();});
 it('preserves unregistered source edits without silently freezing stale content',async()=>{const p=configure();await writeFile(join(root,sourcePath),'Unsynchronized author edit.');await expect(p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()})).rejects.toMatchObject({code:'CHAPTER_REVISION_CHANGED'});expect(browser.createDraft).not.toHaveBeenCalled();});
 it('reads an older uncertain package before reporting a newly reviewed revision conflict',async()=>{browser.createDraft=vi.fn(async()=>{throw new Error('unknown autosave');});const p=configure();await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()});await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:sourcePath,content:'Edited after uncertain upload.\n'}]});const newer=(await currentRevision()).revisionId;await expect(p.publish({workId:'book',chapterNumber:1,revisionId:newer,signal:signal()})).rejects.toMatchObject({code:'PUBLISHING_RECONCILIATION_REQUIRED'});expect(browser.createDraft).toHaveBeenCalledOnce();expect(store.listPackages(targetId)).toHaveLength(1);});
 it('uses known historical chapter identities for direct readback without claiming publication',async()=>{const p=configure(2,{1:'known-remote-1'});await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});expect(browser.snapshot).toHaveBeenCalledWith(expect.objectContaining({remoteChapterId:'known-remote-1',expectedTitle:'Scene'}),expect.objectContaining({signal:expect.any(AbortSignal)}));const pkg=store.listPackages(targetId)[0];expect(store.getMegaNovelRun(pkg.manifest.id,1)).toMatchObject({phase:'submit_unknown',remoteChapterId:'known-remote-1'});expect(browser.createDraft).not.toHaveBeenCalled();});
 it('blocks next-chapter admission on all retained manual attempts even above the configured history boundary',async()=>{
  const selected=await currentRevision();const pkg=await packages.prepare({targetId,chapters:[{...selected,number:1,title:'Scene'}],formats:['txt']});
  await packages.beginSubmission({packageId:pkg.manifest.id,chapterNumber:1,expectedVersion:0,eventId:'manual-beyond-boundary'});
  const p=configure(1);await expect(p.ready('book',signal())).rejects.toMatchObject({code:'PUBLISHING_HISTORY_PENDING'});
  expect(browser.snapshot).toHaveBeenCalledOnce();expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();
 });
 it('lets the current publishing stage reconcile its own pending draft without blocking itself',async()=>{
  browser.submit=vi.fn(async()=>{throw new Error('uncertain submit');});const p=configure(1);
  await p.publish({workId:'book',chapterNumber:1,revisionId,signal:signal()});
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
 it('does not begin a remote mutation if stop arrives during package preparation',async()=>{const p=configure(),controller=new AbortController();const original=StateManager.prototype.acquireBookLock;vi.spyOn(StateManager.prototype,'acquireBookLock').mockImplementationOnce(async function(this:StateManager,id:string){const release=await original.call(this,id);controller.abort(new Error('stop during freeze'));return release;});await expect(p.publish({workId:'book',chapterNumber:1,revisionId,signal:controller.signal})).rejects.toThrow('stop during freeze');expect(browser.createDraft).not.toHaveBeenCalled();expect(browser.submit).not.toHaveBeenCalled();});

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
