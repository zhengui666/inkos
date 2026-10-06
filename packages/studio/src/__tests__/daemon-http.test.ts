import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({ instances: [] as any[], config: {} as any, configGate: undefined as any, startGate: undefined as any, stopGate: undefined as any, startError: undefined as any, stopError: undefined as any, loads: 0 }));
vi.mock('@actalk/inkos-core', async importOriginal => {
  const actual = await importOriginal<typeof import('@actalk/inkos-core')>();
  return { ...actual, createLLMClient: vi.fn(() => ({})), loadProjectConfig: vi.fn(async () => { f.loads++; await f.configGate?.promise; return f.config; }),
    Scheduler: class {
      isRunning = false; stopCalls = 0;
      constructor(readonly config: any) { f.instances.push(this); }
      async start() { await f.startGate?.promise; if (f.startError) throw f.startError; this.isRunning = true; }
      async stop() { this.stopCalls++; this.isRunning = false; await f.stopGate?.promise; if (f.stopError) throw f.stopError; }
    }
  };
});
import { createStudioServer, shutdownStudioServer } from '../api/server.js';
let root: string; const pending: Promise<any>[] = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function settle() { for (let n=0;n<15;n++) await new Promise(r => setImmediate(r)); }
const post = (app: ReturnType<typeof createStudioServer>, path: string) => { const promise=Promise.resolve(app.request('/api/v1/daemon/'+path,{method:'POST'}));pending.push(promise.catch(()=>{}));return promise; };
beforeEach(async () => {
 root=await mkdtemp(join(tmpdir(),'inkos-independent-http-')); f.instances=[];f.configGate=f.startGate=f.stopGate=f.startError=f.stopError=undefined;f.loads=0;
 f.config={name:'fixture',version:'0.1.0',language:'en',llm:{model:'fixture',provider:'openai'},notify:[],daemon:{workIds:['authorized-book'],publicationPollMs:180000,market:{platform:'meganovel',language:'en',maxSourceAgeMs:86400000,liveMegaNovel:false,autoCreate:{maxActiveBooks:1,targetChapters:10,chapterWordCount:1000}},schedule:{writeCron:'*/15 * * * *',radarCron:'0 */6 * * *'},maxConcurrentBooks:1,chaptersPerCycle:1,retryDelayMs:1000,cooldownAfterChapterMs:0,maxChaptersPerDay:2}};
});
afterEach(async()=>{f.configGate?.resolve();f.startGate?.resolve();f.stopGate?.resolve();await Promise.all(pending.splice(0));await rm(root,{recursive:true,force:true});});
const app=()=>createStudioServer(f.config,root);
describe('independent actual Studio HTTP route contract',()=>{
 it('preserves the selected old-book boundary and market/publication settings',async()=>{const server=app();expect((await post(server,'start')).status).toBe(200);expect(f.instances).toHaveLength(1);expect(f.instances[0].config).toMatchObject({workIds:['authorized-book'],market:f.config.daemon.market,publicationPollMs:180000});await post(server,'stop');});
 it('does not acknowledge start or report running before start succeeds',async()=>{f.startGate=gate();const server=app();let resolved=false;const started=post(server,'start').then(r=>{resolved=true;return r;});await settle();expect(f.instances).toHaveLength(1);expect(resolved).toBe(false);expect((await (await server.request('/api/v1/daemon')).json()).running).toBe(false);f.startGate.resolve();expect((await started).status).toBe(200);await post(server,'stop');});
 it('returns the actual owner-conflict error instead of HTTP success',async()=>{f.startError=Object.assign(new Error('A daemon already owns this project.'),{code:'DAEMON_BUSY'});const server=app();const response=await post(server,'start');expect(response.status).toBeGreaterThanOrEqual(400);expect(await response.text()).toMatch(/DAEMON_BUSY|already owns/);expect((await (await server.request('/api/v1/daemon')).json()).running).toBe(false);});
 it('keeps one instance across concurrent starts before config resolves',async()=>{f.configGate=gate();const server=app();const first=post(server,'start');await settle();const second=post(server,'start');f.configGate.resolve();const responses=await Promise.all([first,second]);expect(f.instances).toHaveLength(1);expect(responses.filter(r=>r.status===200)).toHaveLength(1);await post(server,'stop');});
 it('does not acknowledge stop or accept replacement until drain completes',async()=>{const server=app();await post(server,'start');f.stopGate=gate();let resolved=false;const stopped=post(server,'stop').then(r=>{resolved=true;return r;});await settle();expect(resolved).toBe(false);const replacement=await post(server,'start');expect(replacement.status).toBeGreaterThanOrEqual(400);expect(f.instances).toHaveLength(1);f.stopGate.resolve();expect((await stopped).status).toBe(200);expect((await post(server,'start')).status).toBe(200);expect(f.instances).toHaveLength(2);await post(server,'stop');});
 it('honors stop arriving during slow configuration and never leaves a late daemon',async()=>{f.configGate=gate();const server=app();const started=post(server,'start');await settle();let stoppedResolved=false;const stopped=post(server,'stop').then(r=>{stoppedResolved=true;return r;});await settle();expect(stoppedResolved).toBe(false);f.configGate.resolve();await Promise.all([started,stopped]);expect((await (await server.request('/api/v1/daemon')).json()).running).toBe(false);expect(f.instances.every(s=>!s.isRunning)).toBe(true);});
 it('uses one configuration snapshot and rejects a second completed start',async()=>{const server=app();expect((await post(server,'start')).status).toBe(200);expect(f.loads).toBe(1);expect((await post(server,'start')).status).toBe(409);expect(f.instances).toHaveLength(1);await post(server,'stop');});
 it('coalesces simultaneous stop calls and permits harmless repeated stop after drain',async()=>{const server=app();await post(server,'start');f.stopGate=gate();let done=0;const one=post(server,'stop').then(r=>{done++;return r;});const two=post(server,'stop').then(r=>{done++;return r;});await settle();expect(done).toBe(0);expect(f.instances[0].stopCalls).toBe(1);f.stopGate.resolve();expect((await one).status).toBe(200);expect((await two).status).toBe(200);expect((await post(server,'stop')).status).toBe(200);expect(f.instances[0].stopCalls).toBe(1);});
 it('surfaces drain failure and retains admission lock instead of reporting stopped',async()=>{const server=app();await post(server,'start');f.stopError=new Error('Synthetic drain failed');const stopped=await post(server,'stop');expect(stopped.status).toBe(500);expect(await stopped.text()).toContain('Synthetic drain failed');expect(await(await server.request('/api/v1/daemon')).json()).toMatchObject({phase:'failed'});expect((await post(server,'start')).status).toBe(409);expect(f.instances).toHaveLength(1);f.stopError=undefined;await post(server,'stop');});
 it('permanently rejects start after application shutdown even if shutdown finishes',async()=>{const server=app();await post(server,'start');await shutdownStudioServer(server);const restarted=await post(server,'start');expect(restarted.status).toBe(409);expect(await restarted.text()).toContain('STUDIO_SHUTTING_DOWN');expect((await server.request('/api/v1/events')).status).toBe(503);expect(f.instances).toHaveLength(1);});

});
