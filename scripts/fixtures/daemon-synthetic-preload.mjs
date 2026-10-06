// Test-only Agent outputs. Product CLI, scheduler, Goal, writing persistence and
// SQLite ownership are unmodified. Never use this file for production writing.
import { appendFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlannerAgent } from '../../packages/core/dist/agents/planner.js';
import { WriterAgent } from '../../packages/core/dist/agents/writer.js';
import { ContinuityAuditor } from '../../packages/core/dist/agents/continuity.js';
import { StateValidatorAgent } from '../../packages/core/dist/agents/state-validator.js';
import { RadarAgent } from '../../packages/core/dist/agents/radar.js';
import { buildRuntimeStateArtifacts } from '../../packages/core/dist/state/runtime-state-store.js';
import { recordExecutionEvidence } from '../../packages/core/dist/harness/execution-evidence.js';
const root=process.cwd();
const record = (type, data={}) => appendFile(join(root,'synthetic-events.jsonl'),JSON.stringify({at:Date.now(),pid:process.pid,type,...data})+'\n');
globalThis.fetch=async()=>{throw new Error('NETWORK_DISABLED: synthetic daemon lifecycle test');};
PlannerAgent.prototype.planChapter=async input=>({intent:{chapter:input.chapterNumber,goal:'SYNTHETIC RUNTIME TEST'},memo:{chapter:input.chapterNumber,goal:'Runtime test',body:'Synthetic isolated scene',threadRefs:[]},intentMarkdown:'Synthetic isolated scene',runtimePath:`runtime/chapter-${input.chapterNumber}.intent.md`,plannerInputs:[]});
WriterAgent.prototype.writeChapter=async function(input){
 const chapter=input.chapterNumber;
 await record('writer-entered',{chapter});
 if(chapter===2){
  let marker;
  try{marker=await open(join(root,'crash-marker'),'wx');}catch(e){if(e.code!=='EEXIST')throw e;}
  if(marker){await marker.close();await record('waiting-for-test-crash',{chapter});await new Promise((resolve,reject)=>{const timer=setInterval(()=>{},1000);this.ctx.signal?.addEventListener('abort',()=>{clearInterval(timer);reject(this.ctx.signal.reason);},{once:true});});}
 }
 if(chapter===4 && process.env.INKOS_SYNTHETIC_DRAIN==='1'){
  await record('waiting-for-test-stop',{chapter});
  await new Promise((resolve,reject)=>{const timer=setInterval(()=>{},1000);this.ctx.signal?.addEventListener('abort',()=>{clearInterval(timer);setTimeout(()=>reject(this.ctx.signal.reason),1200);},{once:true});});
 }
 const bookDir=join(root,'works','runtime-fixture','source');
 const artifacts=await buildRuntimeStateArtifacts({bookDir,language:'en',delta:{chapter,factOps:{upsert:[{subject:'fixture',predicate:'location',object:`test room ${chapter}`}],expire:[]},hookOps:{upsert:[],mention:[],resolve:[],defer:[]},newHookCandidates:[],chapterSummary:{chapter,title:`Synthetic ${chapter}`,characters:'fixture',events:'The fixture moves.',stateChanges:'Test only.',hookActivity:'',mood:'neutral',chapterType:'investigation'}}});
 recordExecutionEvidence('synthetic-daemon-worker',{chapter});
 await record('writer-returned',{chapter});
 return {chapterNumber:chapter,title:`Synthetic ${chapter}`,content:'The fixture closes the ledger and leaves the test room.',wordCount:11,postSettlement:'',runtimeStateDelta:artifacts.resolvedDelta,runtimeStateSnapshot:artifacts.snapshot,updatedState:artifacts.currentStateMarkdown,updatedHooks:artifacts.hooksMarkdown,updatedChapterSummaries:artifacts.chapterSummariesMarkdown,runtimeStateApplied:true};
};
ContinuityAuditor.prototype.auditChapter=async()=>({summary:'SYNTHETIC REVIEW ONLY',observations:[]});
StateValidatorAgent.prototype.validate=async()=>({consistent:true,reconciliationRequired:false,observations:[]});
RadarAgent.prototype.scan=async()=>{await record('synthetic-radar');return {recommendations:[],marketSummary:'SYNTHETIC RUNTIME TEST; no market evidence or model calls',timestamp:new Date().toISOString()};};
