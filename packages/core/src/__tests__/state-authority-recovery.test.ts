import { CodexFixture } from './codex-fixture.js';
const codex = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../codex/client.js', () => ({ createCodexClient: codex.create }));
import {expect,it,vi} from 'vitest';
import {validateChapterTruthPersistence} from '../pipeline/chapter-truth-validation.js';
import type {WriteChapterOutput} from '../agents/writer.js';
import type {ValidationResult} from '../agents/state-validator.js';
import {StateValidatorAgent} from '../agents/state-validator.js';
import {createLLMClient} from '../llm/provider.js';
import {createHash} from 'node:crypto';

it('retains the same authority context through initial validation and settlement reconciliation',async()=>{
  const authority={storyFrame:'Current author-approved setting',bookRules:'Current professional boundary',chapterSummaries:'Earlier chapters only'};
  const initial={updatedState:'Initial projection',updatedHooks:'Prior hooks'} as WriteChapterOutput;
  const corrected={...initial,updatedState:'Reconciled projection'};
  const validate=vi.fn<(...args:unknown[])=>Promise<ValidationResult>>()
    .mockResolvedValueOnce({consistent:false,reconciliationRequired:true,observations:[]})
    .mockResolvedValueOnce({consistent:true,reconciliationRequired:false,observations:[]});
  const settleChapterState=vi.fn().mockResolvedValue(corrected);
  const result=await validateChapterTruthPersistence({writer:{settleChapterState},validator:{validate},book:{} as never,bookDir:'/unused',chapterNumber:1,title:'Chapter',content:'Current chapter',persistenceOutput:initial,previousTruth:{oldState:'Baseline',oldHooks:'Prior hooks'},authorityContext:authority,reducedControlInput:{chapterIntent:'Current intent',contextPackage:{} as never},language:'en',logWarn:()=>{}});
  expect(validate).toHaveBeenCalledTimes(2);
  expect(validate.mock.calls.map(args=>args[7])).toEqual([authority,authority]);
  expect(settleChapterState).toHaveBeenCalledTimes(1);
  expect(result.persistenceOutput).toBe(corrected);
  expect(result.validation).toMatchObject({consistent:true,reconciliationRequired:false});
});

it('requires a concrete report for reconciliation and preserves it through a Codex dynamic tool result',async()=>{
  const requests:Array<{messages:Array<{role:string,content:string}>}>=[];
  const report='## Projection mismatch\nThe declared workshop location must remain attached to the character.';
  const fixture=new CodexFixture(view=>{requests.push({messages:[{role:'system',content:view.thread.baseInstructions},...view.messages]});return{calls:[{name:'submit_state_validation',args:{reconciliationRequired:true,reportMarkdown:requests.length===1?'':report}}]};});codex.create.mockImplementation(fixture.createClient);
  try{
    const client=createLLMClient({service:'custom',provider:'openai',configSource:'studio',model:'fixture',apiKey:'fixture',baseUrl:'https://fixture.invalid/v1',apiFormat:'chat',stream:true,temperature:0,thinkingBudget:0});
    const result=await new StateValidatorAgent({client,model:'fixture',projectRoot:'/tmp'}).validate('Current chapter',1,'Prior state','Proposed state','Prior hooks','Proposed hooks','en',{storyFrame:'Current authority'});
    expect(result).toMatchObject({consistent:false,reconciliationRequired:true,observations:[{code:'state-reconciliation'}]});
    const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
    expect(sha(result.observations[0].summary)).toBe(sha(report));
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].messages.find(m=>m.role==='tool')!.content)).toMatchObject({code:'STATE_RECONCILIATION_REASON_REQUIRED'});
  }finally{codex.create.mockReset();}
},15000);
