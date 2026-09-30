import {it,expect,vi} from 'vitest';
import {CodexFixture} from './codex-fixture.js';
const createCodexClient=vi.hoisted(()=>vi.fn());
vi.mock('../codex/client.js',()=>({createCodexClient}));
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkManifest,saveWorkManifest} from '../harness/work-store.js';
import {syncWorkSourceArtifacts} from '../harness/source-sync.js';
import {withExecutionEvidence} from '../harness/execution-evidence.js';
import {ContinuityAuditor} from '../agents/continuity.js';
import {createLLMClient} from '../llm/provider.js';
import {TurnArtifactDeliveries} from '../agent/turn-completion.js';
import {ActionResultSchema} from '../harness/contracts.js';

it('reviews a native chapter against its episode baseline and prevents delivery while its scope finding is unresolved',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inkos-chapter-scope-'));const inputs:any[]=[];
 const codex=new CodexFixture(view=>{
  const input=JSON.parse([...view.messages].reverse().find(message=>message.role==='user')!.content);inputs.push(input);
  const observation={code:'FIXTURE_EDIT_SCOPE',category:'scope',assessment:inputs.length===1?'issue':'resolved',summary:'Fixture scope assessment against before/current source.',sourceRefs:[{sourceId:'chapter-1',startLine:1,endLine:1},{sourceId:input.comparison.sourceId,startLine:1,endLine:1}]};
  return {calls:[{name:view.thread.dynamicTools[0].name,args:{summary:'Scoped chapter review.',observations:[observation]}}]};
 });
 createCodexClient.mockImplementation(codex.createClient);
 try{
  await saveWorkManifest(root,createWorkManifest({id:'book',title:'Gallery',profileId:'longform-novel',language:'en'}));await mkdir(join(root,'works/book/source/chapters'),{recursive:true});
  const path='works/book/source/chapters/0001_Closing.md';
  const initialBody='Nora opens the gallery.\n\nShe checks the clock.\n';
  const before=await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:path,content:'# Chapter 1: Closing\n\n'+initialBody}]});
  const client=createLLMClient({service:'custom',provider:'openai',configSource:'studio',model:'fixture',apiKey:'fixture',baseUrl:'https://unused.invalid/v1',apiFormat:'chat',stream:false,temperature:0,thinkingBudget:0});
  const auditor=new ContinuityAuditor({client,model:'fixture',projectRoot:root,bookId:'book'}),deliveries=new TurnArtifactDeliveries();
  for(const [index,body] of ['Eli closes the gallery.\n\nShe checks the time on her watch.\n','Nora opens the gallery.\n\nShe checks the time on her watch.\n'].entries()){
   const current=await syncWorkSourceArtifacts({projectRoot:root,workId:'book',accept:true,writes:[{relativePath:path,content:'# Chapter 1: Closing\n\n'+body}]});
   const review=await withExecutionEvidence(()=>{},()=>auditor.auditChapter('',body,1,undefined,{language:'en',contextPackage:{chapter:1,selectedContext:[]}}),undefined,before,'Change only the final paragraph, preserving the first paragraph; review the result.');
   expect(review.reviewedArtifact).toEqual({workId:'book',artifactId:current.artifacts[0]!.id,revisionId:current.artifacts[0]!.currentRevisionId});
   expect(inputs[index].comparison).toMatchObject({scope:'episode_start',before:{revisionId:before.artifacts[0]!.currentRevisionId},after:{revisionId:current.artifacts[0]!.currentRevisionId}});
   deliveries.observe(ActionResultSchema.parse({status:'success',summary:review.summary,artifacts:[],observations:review.observations,data:{kind:'chapter_review',workId:'book',reviewedArtifact:review.reviewedArtifact,observations:review.observations}}));
   if(index===0)await expect(deliveries.validate(root)).rejects.toMatchObject({code:'TURN_REVISION_SCOPE_UNRESOLVED'});
   else await expect(deliveries.validate(root)).resolves.toBeUndefined();
  }
  expect(inputs).toHaveLength(2);
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
