// Opt-in credential-free real-process smoke test. Requires pnpm build.
// Waits for three natural minute boundaries; output is synthetic, never production.
// Usage: node scripts/verify-daemon-runtime.mjs [evidence.json]
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StateManager,createWorkManifest,saveWorkManifest,SchedulerStore,ChapterGoalService} from '../packages/core/dist/index.js';
import {createInitialRuntimeState} from '../packages/core/dist/state/runtime-state-store.js';
const dir=dirname(fileURLToPath(import.meta.url));
const cli=resolve(dir,'../packages/cli/dist/index.js'),preload=resolve(dir,'fixtures/daemon-synthetic-preload.mjs');
const root=await mkdtemp(join(tmpdir(),'inkos-natural-runtime-'));const children=[];const evidence={root,startedAt:new Date().toISOString(),clock:'real wall clock, no fake timers',scope:'real product CLI/Scheduler/Goal/SQLite; synthetic model Agent outputs; no browser/network/payment/publication',checks:[]};
const env={PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',NODE_NO_WARNINGS:'1',INKOS_SYNTHETIC_DRAIN:'1'};
const run=(args)=>execFileSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',timeout:10000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const records=async()=>{try{return (await readFile(join(root,'synthetic-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const until=async(fn,why,ms=75000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await fn();if(value)return value;await sleep(100);}throw new Error('Timed out: '+why);};
const launch=()=>{const child=spawn(process.execPath,['--import',preload,cli,'up','--work','runtime-fixture'],{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(child);let output='';child.stdout.on('data',x=>{output+=x;process.stdout.write(x);});child.stderr.on('data',x=>{output+=x;process.stderr.write(x);});child.output=()=>output;child.done=new Promise((r,j)=>{child.once('error',j);child.once('exit',(code,signal)=>r({code,signal}));});return child;};
const kill=async child=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGKILL');await child.done;};
let store,goals;
try{
 run(['init','--lang','en']);
 const config=JSON.parse(await readFile(join(root,'inkos.json'),'utf8'));
 config.llm={provider:'openai',service:'custom',configSource:'studio',model:'synthetic',apiKey:'',baseUrl:'http://127.0.0.1:9/v1',apiFormat:'chat',stream:false,temperature:0,thinkingBudget:0};
 config.daemon={schedule:{writeCron:'* * * * *',radarCron:'* * * * *'},maxConcurrentBooks:1,chaptersPerCycle:1,retryDelayMs:0,cooldownAfterChapterMs:0,maxChaptersPerDay:4,workIds:['runtime-fixture']};
 await writeFile(join(root,'inkos.json'),JSON.stringify(config,null,2));
 const state=new StateManager(root),bookDir=state.bookDir('runtime-fixture'),now=new Date().toISOString();
 await saveWorkManifest(root,createWorkManifest({id:'runtime-fixture',title:'Synthetic runtime test',profileId:'longform-novel',language:'en'}));
 await state.saveBookConfig('runtime-fixture',{id:'runtime-fixture',title:'Synthetic runtime test',genre:'general',platform:'other',status:'active',targetChapters:4,chapterWordCount:11,language:'en',createdAt:now,updatedAt:now});
 await mkdir(join(bookDir,'story/outline'),{recursive:true});
 for(const [path,body] of Object.entries({'outline/story_frame.md':'Isolated fixture.','outline/volume_map.md':'Synthetic scenes.','book_rules.md':'Runtime test only.','book_rules.json':JSON.stringify({version:'2',prohibitions:[],enableFullCastTracking:false,allowedDeviations:[]})}))await writeFile(join(bookDir,'story',path),body);
 await createInitialRuntimeState({bookDir,language:'en'});await state.saveChapterIndex('runtime-fixture',[]);await state.snapshotState('runtime-fixture',0);
 store=new SchedulerStore(join(root,'.inkos/harness.sqlite'));goals=new ChapterGoalService({projectRoot:root});
 const first=launch();
 await until(()=>store.latest('runtime-fixture')?.phase==='completed','cold-start fixture chapter completes',30000);
 evidence.checks.push({name:'cold start',at:new Date().toISOString(),job:store.latest('runtime-fixture')});
 const contender=launch();assert.deepEqual(await contender.done,{code:1,signal:null});assert.match(contender.output(),/already owns/);assert.equal(store.runningOwner()?.pid,first.pid);evidence.checks.push({name:'duplicate CLI rejected; original owner retained',at:new Date().toISOString()});
 await until(async()=>(await records()).find(x=>x.type==='waiting-for-test-crash'),'first natural minute dispatch');
 const retained=store.latest('runtime-fixture'),goal=goals.get(retained.goalId),due=store.nextAt('write',0);
 assert.equal(retained.chapter,2);assert.equal(goal.attempts,1);
 await kill(first);const restarted=launch();
 await until(()=>store.latest('runtime-fixture')?.chapter===2&&store.latest('runtime-fixture')?.phase==='completed','crashed Goal recovery',30000);
 const recovered=goals.get(retained.goalId);assert.equal(recovered.id,goal.id);assert.equal(recovered.budget.expiresAt,goal.budget.expiresAt);assert.equal(recovered.attempts,2);assert.equal(store.nextAt('write',0),due);evidence.checks.push({name:'first natural cycle + SIGKILL recovery',at:new Date().toISOString(),goalId:goal.id,attemptsBefore:goal.attempts,attemptsAfter:recovered.attempts,deadline:recovered.budget.expiresAt,nextWriteAt:due});
 await until(()=>store.latest('runtime-fixture')?.chapter===3&&store.latest('runtime-fixture')?.phase==='completed','second natural minute dispatch');
 evidence.checks.push({name:'second natural cycle',at:new Date().toISOString(),job:store.latest('runtime-fixture')});
 await until(async()=>(await records()).find(x=>x.type==='waiting-for-test-stop'),'third natural minute drain fixture');
 const stopStart=Date.now();restarted.kill('SIGTERM');const stopped=await restarted.done;assert.deepEqual(stopped,{code:0,signal:null});assert.ok(Date.now()-stopStart>=1100);assert.equal(store.runningOwner(),undefined);await assert.rejects(access(join(root,'inkos.pid')));evidence.checks.push({name:'SIGTERM drains delayed in-flight operation before exit',elapsedMs:Date.now()-stopStart,retainedGoal:goals.get(store.latest('runtime-fixture').goalId)});
 const all=await records();assert.deepEqual(all.filter(x=>x.type==='writer-returned').map(x=>x.chapter),[1,2,3]);assert.ok(all.filter(x=>x.type==='synthetic-radar').length>=3);evidence.syntheticEvents=all;evidence.schedulerEvents=store.events(200);evidence.finishedAt=new Date().toISOString();evidence.result='PASS';console.log(JSON.stringify({result:'PASS',root,checks:evidence.checks.map(x=>x.name)}));
}catch(error){evidence.result='FAIL';evidence.error=String(error?.stack??error);console.error(error);process.exitCode=1;}
finally{for(const child of children)await kill(child);store?.close();goals?.close();await writeFile(process.argv[2] ? resolve(process.argv[2]) : join(root,'lifecycle-evidence.json'),JSON.stringify(evidence,null,2));console.log('Isolated project retained for evidence: '+root);}
