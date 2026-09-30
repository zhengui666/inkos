import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect,vi} from 'vitest';
import {CodexFixture} from '../../../core/src/__tests__/codex-fixture.js';
const createCodexClient=vi.hoisted(()=>vi.fn());
vi.mock('../../../core/src/codex/client.js',()=>({createCodexClient}));
import {createWorkManifest,saveWorkManifest,loadWorkManifest,syncWorkSourceArtifacts,evictAgentCache} from '@actalk/inkos-core';
import {createStudioServer} from '../api/server.js';

it('keeps the original revision across a failed write, server recreation and native retry, while a new request gets a new baseline',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inkos-retry-baseline-'));let phase:'first'|'retry'|'fresh'='first',mainCalls=0,artifactId='',initialRevision='';const reviews:any[]=[];
 let sessionId:string|undefined;
 const codex=new CodexFixture(view=>{
  const body={tools:view.tools,messages:view.messages};
  const send=(name:string,args:unknown)=>({calls:[{name,args}]});
  if(body.tools[0].function.name==='submit_artifact_review'){
   const input=JSON.parse([...body.messages].reverse().find(m=>m.role==='user')!.content);reviews.push(input);
   return send('submit_artifact_review',{summary:'Recorded comparison.',observations:[{category:'scope',assessment:'issue',code:'FIXTURE_SCOPE',summary:'A protected first paragraph changed.',sourceRefs:[{sourceId:input.sources[0].sourceId,startLine:1,endLine:1},{sourceId:input.comparison.sourceId,startLine:1,endLine:1}]}]});
  }
  if(phase==='first'){
   if(mainCalls++===0)return send('workspace__replace_work_artifact',{path:'source/script.md',content:'Eli closes the gallery.\n\nThe visitor waits by the door.\n',expectedRevisionId:initialRevision});
   return {error:'Fixture transport failure after persisted edit.'};
  }
  if(phase==='retry'&&mainCalls++===0)return send('workspace__review_work_artifact',{artifactId,instruction:'Review the current revision against the original request.'});
  return send('finish_turn',{status:'blocked',message:'A protected passage still needs restoration.'});
 });
 createCodexClient.mockImplementation(codex.createClient);
 try{
  await mkdir(join(root,'.inkos'));
  await writeFile(join(root,'inkos.json'),JSON.stringify({name:'fixture',version:'0.1.0',language:'en'}));
  await saveWorkManifest(root,createWorkManifest({id:'gallery',profileId:'script',title:'Gallery',language:'en'}));
  await mkdir(join(root,'works/gallery/source'),{recursive:true});
  const original=await syncWorkSourceArtifacts({projectRoot:root,workId:'gallery',accept:true,writes:[{relativePath:'works/gallery/source/script.md',content:'Nora opens the gallery.\n\nThe visitor waits.\n'}]});artifactId=original.artifacts[0]!.id;initialRevision=original.artifacts[0]!.currentRevisionId!;
  const app=createStudioServer({} as never,root),post=(body:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const {session}=await(await app.request('/api/v1/sessions',post({sessionKind:'work',profileId:'script',workId:'gallery'}))).json();
  sessionId=session.sessionId;
  const instruction='Change only the final paragraph; preserve the first paragraph and review the result.',request={sessionId:session.sessionId,instruction,workId:'gallery',profileId:'script',model:'fixture',service:'custom:fixture'};
  const first=await app.request('/api/v1/agent',post({...request,clientRequestId:'first-request'}));expect(first.status).toBeGreaterThanOrEqual(400);
  const afterWrite=await loadWorkManifest(root,'gallery');expect(afterWrite.artifacts[0]!.currentRevisionId).not.toBe(initialRevision);
  const restarted=createStudioServer({} as never,root),detail=await(await restarted.request(`/api/v1/sessions/${session.sessionId}`)).json();
  expect(detail.chatRequest.retry.options.retryOfRequestId).toBe('first-request');expect(detail.chatRequest.baselineWork.artifacts[0].currentRevisionId).toBe(initialRevision);
  phase='retry';mainCalls=0;
  const retry=await restarted.request('/api/v1/agent',post({...request,clientRequestId:'second-request',retryOfRequestId:'first-request'}));expect(retry.status).toBe(422);
  expect(reviews).toHaveLength(1);expect(reviews[0].comparison.before.revisionId).toBe(initialRevision);expect(reviews[0].comparison.after.revisionId).toBe(afterWrite.artifacts[0]!.currentRevisionId);
  const stale=await restarted.request('/api/v1/agent',post({...request,clientRequestId:'stale-attempt',retryOfRequestId:'first-request'}));expect(stale.status).toBe(409);expect((await stale.json()).error.code).toBe('CHAT_RETRY_CONFLICT');
  const retained=await(await restarted.request(`/api/v1/sessions/${session.sessionId}`)).json();expect(retained.chatRequest.requestId).toBe('second-request');expect(retained.chatRequest.baselineWork.artifacts[0].currentRevisionId).toBe(initialRevision);
  phase='fresh';await restarted.request('/api/v1/agent',post({...request,instruction:'Review this current draft.',clientRequestId:'fresh-request'}));
  const fresh=await(await restarted.request(`/api/v1/sessions/${session.sessionId}`)).json();expect(fresh.chatRequest.baselineWork.artifacts[0].currentRevisionId).toBe(afterWrite.artifacts[0]!.currentRevisionId);
 }finally{if(sessionId)evictAgentCache(sessionId);await rm(root,{recursive:true,force:true});}
},20000);
