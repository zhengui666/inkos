import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { RuntimeClient } from '@actalk/inkos-core';

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-process-')); roots.push(root);
  await writeFile(join(root, 'inkos.json'), JSON.stringify({ name: 'Process checks', durable: { retry: { maxRetries: 0 } } }));
  return root;
}
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Expected persisted state was not observed before timeout');
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const client = await RuntimeClient.find(root); if (client) { await client.stop(); await until(async () => alive(client.endpoint.pid), value => !value); }
    try { const log = await readFile(join(root, '.inkos/runtime.log'), 'utf8'); if (log.includes('[runtime request]')) console.error(log); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
it('uses one owner for concurrent clients, isolates two projects, and never opens client execution SQLite', async () => {
  const root = await project(), other = await project();
  const clients = await Promise.all(Array.from({ length: 6 }, () => RuntimeClient.connect(root)));
  expect(new Set(clients.map(client => client.endpoint.pid)).size).toBe(1);
  const second = await RuntimeClient.connect(other); expect(second.endpoint.pid).not.toBe(clients[0]!.endpoint.pid);
  await clients[0]!.rpc('works.create', { id: 'only-first', title: 'First' });
  expect(await second.rpc('works.list')).toEqual([]);
  const script = resolve('dist/runtime/service-main.js');
  const duplicate = spawn(process.execPath, [script, '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; duplicate.stderr.on('data', chunk => { error += chunk; });
  const code = await new Promise(resolve => duplicate.once('exit', resolve));
  expect(code).toBe(1); expect(error).toContain('already has an owner');
  await clients[0]!.stop(); await until(async () => alive(clients[0]!.endpoint.pid), value => !value);
  expect((await second.rpc('status')).pid).toBe(second.endpoint.pid);
}, 25_000);
it('loads a project-local official extension, resumes a killed native task, and retains saved bytes exactly once', async () => {
  const root = await project();
  const sdk = execFileSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@earendil-works/pi-durable'))"], { encoding: 'utf8' }).trim();
  const ai = execFileSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@earendil-works/pi-ai'))"], { encoding: 'utf8' }).trim();
  const core = pathToFileURL(resolve('dist/index.js')).href;
  const module = `
import { defineExtension, defineTool, defineTask } from ${JSON.stringify(sdk)};
import { Type } from ${JSON.stringify(ai)};
import { saveArtifact, savedRevision, Works, commitRevision } from ${JSON.stringify(core)};
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export default ({rootDir}) => Object.assign(defineExtension({ name:'local.archive',
  tools:[defineTool({name:'local_echo',description:'Echo author text.',parameters:Type.Object({text:Type.String()}),replay:'safe',execute:async a=>({content:[{type:'text',text:a.text}]})})],
  tasks:[defineTask({name:'local.archive',version:1,initial:()=>({phase:'write'}),phases:{
    write:async(task,runtime,ctx)=>{
      if(!await savedRevision(rootDir,task.input.workId,'archive','saved')) {
        await saveArtifact(rootDir,{id:'saved',workId:task.input.workId,artifactId:'archive',title:'Archive',content:task.input.content,format:'text',metadata:{role:'content'}});
        await appendFile(join(rootDir,'writes.txt'),'saved\\n');
      }
      await runtime.commit(()=>({status:'running',checkpoint:{phase:'wait'}}),ctx);
    },
    wait:async(task,runtime,ctx)=>{
      await runtime.sleep(task.input.until,ctx);
      const work=await runtime.snapshot(Works,task.input.workId,ctx);
      const revision=await savedRevision(rootDir,task.input.workId,'archive','saved');
      await runtime.commit(async tx=>{await commitRevision(tx,work,revision);return {status:'terminal',outcome:{status:'completed',result:{revisionId:revision.id}}}},ctx);
    }
  },abort:async(_t,r,c)=>{await r.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c)}})]
}), {profiles:[{id:'local-verse',label:'Local verse',format:'text',countingUnit:'grapheme',domainKind:'verse',instructions:'Retain author verse.',parseDomain:text=>({verse:text})}]});`;
  await writeFile(join(root, 'local.mjs'), module);
  await writeFile(join(root, 'inkos.json'), JSON.stringify({ plugins: ['./local.mjs'], durable: { retry: { maxRetries: 0 } } }));
  const client = await RuntimeClient.connect(root);
  const plugins = await client.rpc('plugins.list');
  expect(plugins.find((item: any) => item.name === 'local.archive')).toMatchObject({ tools: ['local_echo'], tasks: ['local.archive'], profiles: [{ id: 'local-verse' }] });
  await client.rpc('works.create', { id: 'local-work', title: 'Local work', profile: 'local-verse', locale: 'ja', plan: { review: { enabled: false } } });
  const verse = await client.rpc('creation.start', { workId: 'local-work', content: '夕暮れの歌', artifactId: 'verse', revisionId: 'verse1', requestId: 'verse-request' });
  expect((await client.rpc('tasks.wait', { id: verse.taskId })).state.outcome.status).toBe('completed');
  expect((await client.rpc('works.get', { id: 'local-work' })).domain.verse).toBe('夕暮れの歌');
  const started = await client.rpc('tasks.create', { kind: 'local.archive', input: { workId: 'local-work', content: 'Already saved author content.', until: Date.now() + 4000 } });
  await until(() => client.rpc('tasks.get', { id: started.taskId }), task => task?.state.checkpoint?.phase === 'wait');
  const revisionPath = join(root, '.inkos/artifacts/local-work/archive/saved/content.txt');
  const before = (await stat(revisionPath)).mtimeMs;
  const disconnected = new AbortController(); let sawSnapshot = false;
  const events = client.events(event => { if (event.type === 'snapshot') { sawSnapshot = true; disconnected.abort(); } }, { signal: disconnected.signal }).catch(error => { if (!disconnected.signal.aborted) throw error; });
  await until(async () => sawSnapshot, value => value); await events;
  expect((await client.rpc('tasks.get', { id: started.taskId })).state.status).not.toBe('terminal');
  process.kill(client.endpoint.pid, 'SIGKILL'); await until(async () => alive(client.endpoint.pid), value => !value);
  const reopened = await RuntimeClient.connect(root); expect(reopened.endpoint.pid).not.toBe(client.endpoint.pid);
  expect((await reopened.rpc('tasks.wait', { id: started.taskId })).state.outcome).toEqual({ status: 'completed', result: { revisionId: 'saved' } });
  expect((await reopened.rpc('artifacts.read', { id: 'archive' })).content).toBe('Already saved author content.');
  expect((await stat(revisionPath)).mtimeMs).toBe(before); expect(await readFile(join(root, 'writes.txt'), 'utf8')).toBe('saved\n');
  const again = await reopened.rpc('creation.start', { workId: 'local-work', content: 'Must not change it', requestId: 'verse-request' }); expect(again.taskId).toBe(verse.taskId);
  const noteConversation = await reopened.rpc('conversations.create');
  const draft = { type: 'write', requestId: 'stable-note', entry: { kind: 'inkos.note', data: { text: 'Stable note' } } };
  const one = await reopened.rpc('conversations.submit', { id: noteConversation.id, draft });
  expect((await reopened.rpc('conversations.submit', { id: noteConversation.id, draft })).id).toBe(one.id);
  expect((await stat(join(root, '.inkos/durable.sqlite'))).size).toBeGreaterThan(0);
}, 25_000);
