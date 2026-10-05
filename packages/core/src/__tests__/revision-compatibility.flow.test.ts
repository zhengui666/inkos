import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialWorkManifestWrite, syncWorkSourceArtifacts } from '../harness/source-sync.js';
import { readArtifactRevision } from '../harness/artifact-reader.js';
import { loadWorkManifest, saveWorkManifest } from '../harness/work-store.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { GoalStore } from '../goals/store.js';
import { ManualPublishingAdapter, PublishingStore } from '../publishing/index.js';

const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'inkos-revision-compat-'));roots.push(root);
  const text='The original retained chapter.\n';
  const writes=[{relativePath:'works/book/source/chapters/0001_First.md',content:text}];
  const initial=createInitialWorkManifestWrite({workId:'book',title:'Book',profileId:'long-form',language:'en',writes});
  await commitAtomicFileSet({rootDir:root,writes:[...writes,initial.write]});
  return {root,text};
}
describe('ordinary revision identities and retained older records',()=>{
  it('retains initial actual bytes before an independent snapshot exists',async()=>{
    const {root,text}=await fixture();
    const work=await loadWorkManifest(root,'book'),artifact=work.artifacts[0]!;
    await writeFile(join(root,'works/book/source/chapters/0001_First.md'),'Unregistered external change.');
    const selected=await readArtifactRevision({projectRoot:root,workId:'book',artifactId:artifact.id,revisionId:artifact.currentRevisionId!});
    expect(selected.bytes.toString()).toBe(text);
    expect(selected.revision.checksum).toBeUndefined();
  });
  it('preserves old artifact and revision IDs while registering later changed bytes',async()=>{
    const {root,text}=await fixture();
    const work=await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true});
    const artifact=work.artifacts[0]!,revision=artifact.revisions[0]!;
    const legacy={...work,artifacts:[{...artifact,id:'old-artifact-id',currentRevisionId:'old-revision-id',revisions:[{...revision,id:'old-revision-id',checksum:'legacy-stored-value'}]}]};
    await saveWorkManifest(root,legacy);
    const next=await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:'works/book/source/chapters/0001_First.md',content:'Changed after the old revision.\n'}]});
    expect(next.artifacts[0]!.id).toBe('old-artifact-id');
    expect(next.artifacts[0]!.revisions.find(r=>r.id==='old-revision-id')).toEqual({...legacy.artifacts[0]!.revisions[0],status:"superseded"});
    const old=await readArtifactRevision({projectRoot:root,workId:'book',artifactId:'old-artifact-id',revisionId:'old-revision-id'});
    expect(old.bytes.toString()).toBe(text);
    const current=next.artifacts[0]!.revisions.find(r=>r.id===next.artifacts[0]!.currentRevisionId)!;
    expect(current.parentRevisionId).toBe('old-revision-id');expect(current.checksum).toBeUndefined();
  });
  it('does not rewrite an old revision when its declared snapshot is missing',async()=>{
    const {root}=await fixture();
    const work=await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true});
    const artifact=work.artifacts[0]!,revision=artifact.revisions[0]!;
    const {contentBase64:_bytes,...old}=revision;
    await saveWorkManifest(root,{...work,artifacts:[{...artifact,revisions:[old]}]});
    await rm(join(root,'works/book',old.snapshotPath!));
    const next=await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:'works/book/source/chapters/0001_First.md',content:'A later manuscript.'}]});
    expect(next.artifacts[0]!.currentRevisionId).not.toBe(old.id);
    await expect(readFile(join(root,'works/book',old.snapshotPath!))).rejects.toMatchObject({code:'ENOENT'});
    await expect(readArtifactRevision({projectRoot:root,workId:'book',artifactId:artifact.id,revisionId:old.id})).rejects.toMatchObject({code:'ARTIFACT_SNAPSHOT_UNAVAILABLE'});
    expect((await readArtifactRevision({projectRoot:root,workId:'book',artifactId:artifact.id})).bytes.toString()).toBe('A later manuscript.');
  });
  it('opens paused legacy Goal rows and receipts without rewriting them or their events',async()=>{
    const {root}=await fixture(),path=join(root,'.inkos/goals.sqlite');
    let store=new GoalStore(path);
    const created=store.create({id:'old-goal',workId:'book',intent:'Retained request',budget:{maxAttempts:1,expiresAt:Date.now()+60000},steps:[{id:'one',kind:'fixture',input:{chapter:1},maxAttempts:1}]});
    store.close();
    const db=new DatabaseSync(path);
    const row=db.prepare('SELECT data_json FROM goal_steps WHERE goal_id=?').get(created.id)!;
    const step=JSON.parse(String(row.data_json));
    delete step.baselineState;step.inputHash='old-input-value';step.baselineHash='old-baseline-value';step.status='completed';
    step.receipt={operationKey:step.operationKey,artifacts:[{artifactId:'old-artifact',revisionId:'old-revision',checksum:'old-recorded-value',path:'source/chapters/0001.md'}],evidence:{checkpointHash:'old-checkpoint-value'}};
    db.prepare('UPDATE goal_steps SET data_json=? WHERE goal_id=?').run(JSON.stringify(step),created.id);
    const rows=()=>({goals:db.prepare('SELECT * FROM goals').all(),steps:db.prepare('SELECT * FROM goal_steps').all(),events:db.prepare('SELECT * FROM goal_events').all()});
    const before=rows();
    try{store=new GoalStore(path);expect(store.get(created.id).steps[0]!.receipt).toEqual(step.receipt);expect(store.list()[0]!.status).toBe('paused');store.events(created.id);expect(rows()).toEqual(before);}finally{store.close();db.close();}
  });
  it('reuses a legacy package and keeps its original receipt identity',async()=>{
    const {root}=await fixture(),path=join(root,'.inkos/harness.sqlite');
    let store=new PublishingStore(path),adapter=new ManualPublishingAdapter(root,store);
    const target=await adapter.mapBook({workId:'book',platform:'meganovel',accountLabel:'fixture',remoteBookId:'remote-book'});
    const artifact=(await loadWorkManifest(root,'book')).artifacts[0]!;
    const input={targetId:target.id,chapters:[{artifactId:artifact.id,revisionId:artifact.currentRevisionId!,number:1,title:'First'}],formats:['txt'] as ['txt']};
    const pkg=await adapter.prepare(input);store.close();
    const legacy={...pkg.manifest,operationKey:'legacy-operation-key',chapters:pkg.manifest.chapters.map(chapter=>({...chapter,checksum:'legacy-chapter-value'})),files:pkg.manifest.files.map(({contentBase64:_bytes,...file})=>({...file,checksum:'legacy-file-value'}))};
    const db=new DatabaseSync(path);db.prepare('UPDATE publishing_packages SET operation_key=?,manifest_json=? WHERE id=?').run(legacy.operationKey,JSON.stringify(legacy),pkg.manifest.id);db.close();
    await writeFile(join(root,'.inkos/publishing',pkg.manifest.id,'manifest.json'),JSON.stringify(legacy));
    store=new PublishingStore(path);adapter=new ManualPublishingAdapter(root,store);
    try{const reused=await adapter.prepare(input);expect(reused.manifest.id).toBe(pkg.manifest.id);expect(reused.manifest.operationKey).toBe(legacy.operationKey);expect(reused.chapters).toEqual(pkg.chapters);expect(store.listPackages()).toHaveLength(1);
      await writeFile(join(root,'.inkos/publishing',pkg.manifest.id,'manifest.json'),JSON.stringify({...legacy,files:legacy.files.map(file=>({...file,checksum:'ignored-old-metadata'}))}));
      expect((await adapter.verify(pkg.manifest.id)).legacyFilesWithoutSnapshot).toContain('exports/book.txt');}finally{store.close();}
  });
});
