import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// This is an actual compiled-consumer process boundary, not a module reset or fake mutex.
// Run the package's original build before this test.
const ownerURL = pathToFileURL(resolve('dist/runtime/auth/pi-owner.js')).href;
const compatURL = pathToFileURL(resolve('dist/runtime/auth/pi-native-store-compat.js')).href;
const publicURL = pathToFileURL(resolve('dist/index.js')).href;
const code = String.raw`
const { PiAuthenticationOwner } = await import(process.argv[1]);
const { createPiNativeStoreCompat } = await import(process.argv[2]);
const fs = await import('node:fs/promises'); const { join } = await import('node:path');
let network = 0; globalThis.fetch = async () => { network++; throw new Error('External network forbidden'); };
const project = process.argv[3], role = process.argv[4], auth = join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), recordPath = join(process.env.PI_CODING_AGENT_DIR, 'inkos-connection.json');
const owner = role === 'account-probe' ? undefined : await PiAuthenticationOwner.create(project);
const send = (kind, value = {}) => process.send({ kind, ...value });
const release = () => new Promise(resolve => process.once('message', resolve));
const oauth = () => ({type:'oauth',access:'synthetic-rotated',refresh:'synthetic-refresh',expires:Date.now()+3600000});
if (role === 'account-probe') {
  const { PiAccountService } = await import(process.argv[5]);
  const before = await fs.readFile(recordPath, 'utf8'), authBefore = await fs.readFile(auth, 'utf8');
  const service = await PiAccountService.create(project), reserved = service.reserveLoginAttempt(service.readLoginExpectation());
  let error; try { error = service.startLoginAttempt(reserved.handle).error; } catch (failure) { error = failure.code; }
  await service.dispose?.(); send('account-probe', { error, network,
    metadataUnchanged: before === await fs.readFile(recordPath, 'utf8'), authUnchanged: authBefore === await fs.readFile(auth, 'utf8') });
} else if (role === 'refresh') {
  const admitted = await owner.admit(), target = {harnessId:'pi',authContextRef:admitted.authContextRef,connectionRef:admitted.connection.connectionRef,authGeneration:admitted.authGeneration};
  const lease = owner.lease(target);
  await lease.resolveAuth(() => lease.credentials.modify('openai', async () => { send('entered', {target}); await release(); return oauth(); }));
  await lease.drain(); send('done', { owner: await owner.observe() });
} else if (role === 'probe') {
  const before = await fs.readFile(recordPath,'utf8'), authBefore = await fs.readFile(auth,'utf8'), record = JSON.parse(before);
  const target = {harnessId:'pi',authContextRef:record.authContextRef,connectionRef:record.connectionRef,authGeneration:record.authGeneration}, lease=owner.lease(target);
  let rejected=0; const fails=async fn=>{try{await fn();}catch{rejected++;}};
  await fails(()=>owner.admit()); await fails(()=>lease.guard()); await fails(()=>lease.credentials.read('openai'));
  await fails(()=>lease.credentials.list()); await fails(()=>lease.resolveAuth(()=>lease.credentials.modify('openai',async()=>oauth())));
  await fails(()=>owner.beginLogin()); await fails(()=>lease.credentials.modify('openai',async()=>oauth()));
  const observed=await owner.observe(), snapshot=await owner.observeSnapshot(async()=>{throw new Error('must not inspect');});
  send('probe', { rejected, ready:observed?.ready, authentication:snapshot.authentication,
    metadataUnchanged:before===await fs.readFile(recordPath,'utf8'),authUnchanged:authBefore===await fs.readFile(auth,'utf8') });
} else if (role === 'blocker') {
  const storage = await createPiNativeStoreCompat(auth); await storage.modify('openai',async()=>{send('locked');await release();return undefined;});send('done');
} else if (role === 'queued-refresh') {
  const admitted=await owner.admit(),target={harnessId:'pi',authContextRef:admitted.authContextRef,connectionRef:admitted.connection.connectionRef,authGeneration:admitted.authGeneration},lease=owner.lease(target);
  let callbacks=0; const operation=lease.resolveAuth(()=>{send('queued'); return lease.credentials.modify('openai',async()=>{callbacks++;return oauth();});});
  try{await operation;send('unexpected');}catch{send('rejected',{callbacks});} await lease.drain().catch(()=>{});
} else if (role === 'new-login') {
  const ticket=owner.beginLogin();send('ticket',{generation:ticket.authGeneration}); await release();
  const result=await owner.runLogin(ticket,async()=>oauth(),new AbortController().signal);send('done',{result});
}
process.disconnect();
`;
const children: ChildProcess[] = [], dirs: string[] = [];
function worker(project: string, agent: string, role: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, ownerURL, compatURL, project, role, publicURL],
    { env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
  let stderr = ''; child.stderr!.on('data', value => { stderr += value; });
  const queued: { kind: string; [key: string]: unknown }[] = [], listeners: ((value: { kind: string; [key: string]: unknown }) => void)[] = [];
  child.on('message', value => { const next = value as { kind: string; [key: string]: unknown }; const listener = listeners.shift(); listener ? listener(next) : queued.push(next); });
  const message = async () => queued.length ? queued.shift()! : new Promise<{ kind: string; [key: string]: unknown }>((resolve, reject) => {
    listeners.push(resolve); child.once('exit', status => { if (status !== 0) reject(new Error(`fixture process exit ${status}: ${stderr}`)); });
  });
  return { child, message, release: () => child.send({ kind: 'release' }) };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'inkos-pi-cross-process-')); dirs.push(dir);
  const first = join(dir, 'one'), second = join(dir, 'two'), agent = join(dir, 'agent');
  await Promise.all([first, second, agent].map(path => mkdir(path)));
  await writeFile(join(agent, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'synthetic-original', refresh: 'synthetic-original-refresh', expires: Date.now() + 3_600_000 } }));
  return { first, second, agent };
}
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('actual official native storage across Node processes', () => {
  it.each(['refresh', 'new-login'] as const)('seam process: a pending %s maps to public scope-busy without any OAuth or byte changes', async role => {
    const f = await fixture(), pending = worker(f.first, f.agent, role);
    expect((await pending.message()).kind).toBe(role === 'refresh' ? 'entered' : 'ticket');
    const before = await readFile(join(f.agent, 'inkos-connection.json'), 'utf8'), auth = await readFile(join(f.agent, 'auth.json'), 'utf8');
    try {
      const probe = worker(f.second, f.agent, 'account-probe');
      expect(await probe.message()).toMatchObject({ kind: 'account-probe', error: 'scope-busy', network: 0, metadataUnchanged: true, authUnchanged: true });
      expect(await readFile(join(f.agent, 'inkos-connection.json'), 'utf8')).toBe(before); expect(await readFile(join(f.agent, 'auth.json'), 'utf8')).toBe(auth);
    } finally { pending.release(); await pending.message(); }
  });
  it('an entered hanging refresh stays excluded in another project/process until its exact Promise settles', async () => {
    const f = await fixture(), refresh = worker(f.first, f.agent, 'refresh'); expect((await refresh.message()).kind).toBe('entered');
    const pending = await readFile(join(f.agent, 'inkos-connection.json'), 'utf8'); expect(JSON.parse(pending).pendingRefresh.kind).toBe('refresh');
    for (let attempt = 0; attempt < 2; attempt++) {
      const probe = worker(f.second, f.agent, 'probe'); expect(await probe.message()).toMatchObject({ kind: 'probe', rejected: 7, ready: false,
        authentication: 'unknown', metadataUnchanged: true, authUnchanged: true });
      expect(await readFile(join(f.agent, 'inkos-connection.json'), 'utf8')).toBe(pending);
    }
    refresh.release(); const done = await refresh.message(); expect(done).toMatchObject({ kind: 'done', owner: { ready: true, authGeneration: JSON.parse(pending).authGeneration } });
    const final = JSON.parse(await readFile(join(f.agent, 'inkos-connection.json'), 'utf8')); expect(final.pendingRefresh).toBeUndefined();
    expect(JSON.parse(await readFile(join(f.agent, 'auth.json'), 'utf8')).openai.access).toBe('synthetic-rotated');
  });
  it('a refresh queued before native callback entry rejects after a new login ticket; the new ticket survives', async () => {
    const f = await fixture();
    // Establish owner before the external official lock blocks all queued native writers.
    const baseline = worker(f.first, f.agent, 'new-login'); expect((await baseline.message()).kind).toBe('ticket'); baseline.release(); await baseline.message();
    const blocker = worker(f.first, f.agent, 'blocker'); expect((await blocker.message()).kind).toBe('locked');
    const old = worker(f.first, f.agent, 'queued-refresh'); expect((await old.message()).kind).toBe('queued');
    const login = worker(f.second, f.agent, 'new-login'); expect((await login.message()).kind).toBe('ticket');
    const pending = await readFile(join(f.agent, 'inkos-connection.json'), 'utf8'); blocker.release(); await blocker.message();
    expect(await old.message()).toMatchObject({ kind: 'rejected', callbacks: 0 });
    expect(await readFile(join(f.agent, 'inkos-connection.json'), 'utf8')).toBe(pending);
    login.release(); expect(await login.message()).toMatchObject({ kind: 'done', result: { outcome: 'saved' } });
  });
});
