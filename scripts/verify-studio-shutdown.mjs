// Opt-in real Studio server/SSE/SIGTERM smoke test; no model or browser calls.
// Requires pnpm build. Usage: node scripts/verify-studio-shutdown.mjs [source-root]
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const base=resolve(process.argv[2]??fileURLToPath(new URL('..',import.meta.url)));
const root=await mkdtemp(join(tmpdir(),'inkos-independent-sse-'));
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let child;let output='';
try{
 await mkdir(join(root,'home'));
 await writeFile(join(root,'inkos.json'),JSON.stringify({name:'independent-sse',version:'0.1.0',language:'en',llm:{provider:'openai',model:'test-no-agent-run'},daemon:{workIds:[],schedule:{writeCron:'*/15 * * * *',radarCron:'0 */6 * * *'}}}));
 const entry=join(root,'entry.mjs');
 await writeFile(entry,`import {pathToFileURL} from 'node:url';\nconst core=await import(pathToFileURL(${JSON.stringify(join(base,'packages/core/dist/index.js'))}).href);\nconst store=new core.SchedulerStore(${JSON.stringify(join(root,'.inkos/harness.sqlite'))}); store.schedule('write',Date.now()+3600000);store.schedule('radar',Date.now()+3600000);store.close();\nconst {startStudioServer}=await import(pathToFileURL(${JSON.stringify(join(base,'packages/studio/dist/api/server.js'))}).href);\nawait startStudioServer(${JSON.stringify(root)},${port});`);
 child=spawn(process.execPath,[entry],{env:{PATH:process.env.PATH,HOME:join(root,'home'),NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',v=>{output+=v;});child.stderr.on('data',v=>{output+=v;});
 const exited=once(child,'exit');
 let response;
 for(let i=0;i<100;i++){try{response=await fetch(`http://127.0.0.1:${port}/api/v1/daemon`);break;}catch{if(child.exitCode!==null)throw new Error(output);await sleep(50);}}
 assert(response?.ok,`Server did not listen: ${output}`);
 await response.arrayBuffer();
 const started=await fetch(`http://127.0.0.1:${port}/api/v1/daemon/start`,{method:'POST'});
 assert.equal(started.status,200,await started.text());
 const sse=await fetch(`http://127.0.0.1:${port}/api/v1/events`);assert.equal(sse.status,200);
 const reader=sse.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: ping/);
 const before=Date.now();child.kill('SIGTERM');
 const timeout={timeout:true};const result=await Promise.race([exited,sleep(10000).then(()=>timeout)]);
 assert.notEqual(result,timeout,`SIGTERM blocked with SSE connected: ${output}`);
 assert.deepEqual(result,[0,null]);
 let finished=false;while(!finished){finished=(await reader.read()).done;}
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'.inkos/harness.sqlite'));
 try{assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduler_owner').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM scheduler_events WHERE type='daemon-stopped'").get().n,1);}finally{db.close();}
 console.log(JSON.stringify({passed:true,path:'real startStudioServer + actual Scheduler + HTTP SSE + SIGTERM',exit:result,elapsedMs:Date.now()-before,sseClosed:true,ownerReleased:true,agentsOrPublicationInvoked:false}));
}finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await rm(root,{recursive:true,force:true});}
