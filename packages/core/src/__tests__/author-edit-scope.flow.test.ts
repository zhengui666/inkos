import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {it,expect,vi} from 'vitest';
import {CodexFixture} from './codex-fixture.js';
const createCodexClient=vi.hoisted(()=>vi.fn());
vi.mock('../codex/client.js',()=>({createCodexClient}));
import {createWorkManifest,saveWorkManifest} from '../harness/work-store.js';import {syncWorkSourceArtifacts} from '../harness/source-sync.js';import {createLLMClient} from '../llm/provider.js';import {PipelineRunner} from '../pipeline/runner.js';import {createArtifactMethodTools} from '../harness/tools/artifact-methods.js';import {executeExplicitCapabilityTool} from '../harness/explicit-action.js';
it('locates author-authorized text before rewriting and preserves surrounding bytes despite an overbroad coordinator range',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inkos-author-scope-')),requests:any[]=[];
 const codex=new CodexFixture(view=>{const body={tools:view.tools,messages:view.messages};requests.push(body);const name=view.thread.dynamicTools[0].name,args=name==='submit_author_edit_scope'?{wholeDocument:false,selections:[{startLine:3,endLine:3,text:'Maybe.'}],reason:'The final speech line is between protected stage directions.'}:{selection_0_text:'I will stay.'};return {calls:[{name,args}]};});
 createCodexClient.mockImplementation(codex.createClient);
 try{
  const original='The gallery is open.\n\nMARA (facing the window): Maybe.\n\nShe closes the door.\n',authorRequest='Change only Mara’s final spoken response. Preserve both stage directions.';
  await saveWorkManifest(root,createWorkManifest({id:'gallery',profileId:'script',title:'Gallery',language:'en'}));await mkdir(join(root,'works/gallery/source'),{recursive:true});const work=await syncWorkSourceArtifacts({projectRoot:root,workId:'gallery',accept:true,writes:[{relativePath:'works/gallery/source/script.md',content:original}]});
  const llm={service:'custom',provider:'openai' as const,configSource:'studio' as const,model:'fixture',apiKey:'fixture',baseUrl:'https://unused.invalid/v1',apiFormat:'chat' as const,stream:false,temperature:0,thinkingBudget:0,maxTokens:8192};
  const pipeline=new PipelineRunner({projectRoot:root,client:createLLMClient(llm),model:'fixture',defaultLLMConfig:llm});
  await executeExplicitCapabilityTool({projectRoot:root,workId:'gallery',authorRequest,binding:{capabilityId:'workspace',actionId:'revise_work_artifact',profileId:'script',risk:'recoverable-write'},tool:createArtifactMethodTools(pipeline,root,'gallery')[1]!,parameters:{artifactId:work.artifacts[0]!.id,editRanges:[{startLine:1,endLine:5}],instruction:'Rewrite the entire closing passage to make her choice clear.'}});
  expect(requests.map(r=>r.tools[0].function.name)).toEqual(['submit_author_edit_scope','submit_artifact_revision']);
  expect(JSON.parse(requests[0].messages.findLast((m:any)=>m.role==='user').content).authorRequest).toBe(authorRequest);
  expect(JSON.parse(requests[1].messages.findLast((m:any)=>m.role==='user').content).editableSelections).toMatchObject([{startLine:3,endLine:3}]);
  expect(JSON.parse(requests[1].messages.findLast((m:any)=>m.role==='user').content).instruction).toBe(authorRequest);
  expect(await readFile(join(root,'works/gallery/source/script.md'),'utf8')).toBe('The gallery is open.\n\nMARA (facing the window): I will stay.\n\nShe closes the door.\n');
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
