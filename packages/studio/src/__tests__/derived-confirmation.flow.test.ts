import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect,vi} from 'vitest';
import {CodexFixture} from '../../../core/src/__tests__/codex-fixture.js';
const createCodexClient=vi.hoisted(()=>vi.fn());
vi.mock('../../../core/src/codex/client.js',()=>({createCodexClient}));
import {createWorkManifest,saveWorkManifest,syncWorkSourceArtifacts,loadWorkManifest,StateManager} from '@actalk/inkos-core';
import {createStudioServer} from '../api/server.js';

it('reaches confirmed Codex production without a legacy API key and preserves source revision and chapter bounds before a producer failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inkos-confirmed-source-'));let calls=0;
 const codex=new CodexFixture(()=>{calls++;return {error:'Fixture unavailable'};});
 createCodexClient.mockImplementation(codex.createClient);
 try{
  await mkdir(join(root,'.inkos'));
  await writeFile(join(root,'inkos.json'),JSON.stringify({name:'fixture',version:'0.1.0',language:'en'}));
  await saveWorkManifest(root,createWorkManifest({id:'parent',title:'Gallery',profileId:'longform-novel',language:'en'}));
  await mkdir(join(root,'works/parent/source'),{recursive:true});
  const manuscript='Nora returns the borrowed green map.\n';
  const parent=await syncWorkSourceArtifacts({projectRoot:root,workId:'parent',accept:true,writes:[{relativePath:'works/parent/source/manuscript.md',content:manuscript}]});
  const artifact=parent.artifacts[0]!;
  const source={workId:'parent',artifactId:artifact.id,revisionId:artifact.currentRevisionId!};
  const app=createStudioServer({} as never,root);
  const post=(body:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const {session}=await(await app.request('/api/v1/sessions',post({sessionKind:'chat'}))).json();
  const response=await app.request('/api/v1/agent',post({sessionId:session.sessionId,sessionKind:'chat',instruction:'Create a parallel story from the registered Gallery source. Keep each chapter between20and30words.',actionSource:'button',requestedIntent:'fanfic_init',actionPayload:{fanficCreate:{title:'parallel',source,language:'en',chapterWordCount:25,minChapterLength:20,maxChapterLength:30}},model:'fixture-model',service:'custom:fixture'}));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(calls).toBeGreaterThan(0);
  expect(await new StateManager(root).loadBookConfig('parallel')).toMatchObject({chapterWordCount:25,minChapterLength:20,maxChapterLength:30});
  expect((await loadWorkManifest(root,'parallel')).lineage).toEqual([{relation:'derived-from',sourceWorkId:source.workId,sourceArtifactId:source.artifactId,sourceRevisionId:source.revisionId}]);
  expect(await readFile(join(root,'works/parallel/source/source-material.md'),'utf8')).toBe(manuscript);
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
