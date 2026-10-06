import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { acquireMegaNovelCdpLock } from '../publishing/meganovel-cdp-lock.js';

const roots: string[] = [], children: ChildProcess[] = [];
const reservations: ReturnType<typeof acquireMegaNovelCdpLock>[] = [];
let modules: string;
beforeAll(async () => {
  modules = await mkdtemp(join(tmpdir(), 'inkos-cdp-lock-modules-'));
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(modules, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const seen = new Set<string>();
  async function compile(name: string): Promise<void> {
    if (seen.has(name)) return;
    seen.add(name);
    const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
    }).outputText;
    await mkdir(dirname(join(modules, `${name}.js`)), {recursive: true});
    await writeFile(join(modules, `${name}.js`), output);
    for (const match of output.matchAll(/require\(["'](\.[^"']+)\.js["']\)/gu)) {
      await compile(join(dirname(name), match[1]).replaceAll('\\', '/'));
    }
  }
  await compile('publishing/meganovel-cdp-lock');
  await compile('publishing/meganovel-cdp');
  return () => rm(modules, {recursive: true, force: true});
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(kill));
  for (const reservation of reservations.splice(0)) reservation.release();
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'inkos-cdp-lock-'));
  roots.push(root);
  return root;
}
function acquire(root: string, target = 'target-1') {
  const reservation = acquireMegaNovelCdpLock(root, target);
  reservations.push(reservation);
  return reservation;
}
async function launch(root: string, script: string) {
  const child = spawn(process.execPath, ['--expose-gc', '-e', `
    const fs = require('node:fs');
    const root = process.argv[2];
    const {acquireMegaNovelCdpLock} = require(process.argv[1]);
    ${script}
  `, join(modules, 'publishing/meganovel-cdp-lock.js'), root], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  children.push(child);
  const result = await new Promise<{outcome?: string}>((resolve, reject) => {
    let errors = '';
    const timer = setTimeout(() => finish(new Error(`Child readiness timed out: ${errors}`)), 10000);
    const finish = (error?: Error, message?: {outcome?: string}) => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stderr!.removeListener('data', onStderr);
      error ? reject(error) : resolve(message!);
    };
    const onMessage = (message: {outcome?: string}) => finish(undefined, message);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`Child exited ${code}: ${errors}`));
    const onStderr = (data: Buffer) => { errors += data.toString(); };
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stderr!.on('data', onStderr);
  });
  return {child, ...result};
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
const owner = `const lock = acquireMegaNovelCdpLock(root, 'target-1'); process.send({outcome:'acquired'}); setInterval(()=>{},1000);`;

describe('CDP ownership with real processes and SQLite lifetime locks', () => {
  it('recovers after SIGKILL even if the recorded PID belongs to an unrelated live process', async () => {
    const root = await setup();
    const {child} = await launch(root, owner);
    expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
    await kill(child);
    const unrelated = await launch(root, `process.send({}); setInterval(()=>{},1000);`);
    const path = join(root, 'target-1.lock');
    const marker = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({...marker, pid: unrelated.child.pid}));
    expect(() => acquire(root)).not.toThrow();
    expect(unrelated.child.exitCode).toBeNull();
    expect(unrelated.child.signalCode).toBeNull();
  });
  it('reconnects the real transport after its process dies and runs readiness only', async () => {
    const root = await setup();
    const transport = `
      const Module=require('node:module'), original=Module._load;
      const {EventEmitter}=require('node:events'), events=new EventEmitter();
      const scope={sessionId:'target-1',accountId:'account-1',accountLabel:'author',remoteBookId:'book-1'};
      let connected=true;
      const page={url:()=> 'https://www.meganovel.com/fixture-only',isClosed:()=>false,setDefaultTimeout(){},setDefaultNavigationTimeout(){}};
      const browser={once:events.once.bind(events),close:async()=>{connected=false;events.emit('disconnected');},isConnected:()=>connected,
        contexts:()=>[{pages:()=>[page],newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'target-1'}}),detach:async()=>{}})}]};
      Module._load=function(id,...args){return id==='playwright-core'?{chromium:{connectOverCDP:async()=>browser}}:original.call(this,id,...args)};
      const {connectMegaNovelCdpPort}=require(process.argv[1].replace('-lock.js','.js'));
      const binding={protocol:'inkos-meganovel-dom-v1',calibration:{observedAt:'2026-10-06T00:00:00Z',evidence:'Synthetic fixture only'},
        probe:async()=>({scope,origin:'https://www.meganovel.com',blocker:'none'}),snapshot:async()=>{throw new Error('unexpected snapshot')},
        createDraft:async()=>{throw new Error('unexpected mutation')},submit:async()=>{throw new Error('unexpected mutation')}};
      connectMegaNovelCdpPort({endpointURL:'http://127.0.0.1:9222',scope,lockDirectory:root,
        authorization:{automation:{provenance:'user_reported',reference:'fixture'},aiAssistedContent:{provenance:'user_reported',reference:'fixture'}}},binding)
        .then(()=>{process.send({outcome:'connected'});setInterval(()=>{},1000)}).catch(error=>{throw error});
    `;
    const first = await launch(root, transport);
    expect(first.outcome).toBe('connected');
    await kill(first.child);
    expect((await launch(root, transport)).outcome).toBe('connected');
    expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
  });
  it('admits exactly one of four concurrent starts', async () => {
    const root = await setup();
    const attempts = await Promise.all(Array.from({length: 4}, () => launch(root, `
      let lock, outcome;
      try {lock=acquireMegaNovelCdpLock(root,'target-1');outcome='acquired';}
      catch(error){if(error.code!=='MEGANOVEL_BROWSER_BUSY')throw error;outcome='busy';}
      process.send({outcome});setInterval(()=>{},1000);
    `)));
    expect(attempts.map(item => item.outcome).sort()).toEqual(['acquired', 'busy', 'busy', 'busy']);
  });
  it('rejects a live or dead legacy owner without silently migrating its marker', async () => {
    const root = await setup();
    const {child} = await launch(root, `
      fs.writeFileSync(root+'/target-1.lock',JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx'});
      process.send({});setInterval(()=>{},1000);
    `);
    const before = await readFile(join(root, 'target-1.lock'), 'utf8');
    expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
    await kill(child);
    expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
    expect(await readFile(join(root, 'target-1.lock'), 'utf8')).toBe(before);
  });
  it('excludes a legacy wx claimant until normal close and preserves the stable sidecar', async () => {
    const root = await setup();
    const lock = acquire(root);
    const tryLegacy = `
      let outcome;
      try{fs.closeSync(fs.openSync(root+'/target-1.lock','wx'));outcome='acquired';}
      catch(error){if(error.code!=='EEXIST')throw error;outcome='busy';}
      process.send({outcome});setInterval(()=>{},1000);
    `;
    expect((await launch(root, tryLegacy)).outcome).toBe('busy');
    lock.release();
    expect((await launch(root, tryLegacy)).outcome).toBe('acquired');
    expect(await readFile(join(root, 'target-1.lock.sqlite'))).toBeDefined();
  });
  it.each(['', '{"pid":', '{"protocol":"future-v2","token":"new"}', '{"protocol":"inkos-meganovel-cdp-sqlite-v1"}'])
    ('keeps unrecognized marker %j unchanged', async marker => {
      const root = await setup();
      await writeFile(join(root, 'target-1.lock'), marker);
      expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
      expect(await readFile(join(root, 'target-1.lock'), 'utf8')).toBe(marker);
    });
  it.each(['before', 'after'])('recovers a crash %s atomic marker installation', async when => {
    const root = await setup();
    const {child} = await launch(root, `
      const link=fs.linkSync;
      fs.linkSync=(...args)=>{${when === 'after' ? 'link(...args);' : ''}
        process.send({});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
      acquireMegaNovelCdpLock(root,'target-1');
    `);
    await kill(child);
    expect(() => acquire(root)).not.toThrow();
  });
  it('releases a failed marker claim before a second startup in the same process', async () => {
    const root = await setup();
    const result = await launch(root, `
      const link=fs.linkSync;
      fs.linkSync=()=>{throw Object.assign(new Error('fixture write denied'),{code:'EACCES'});};
      try{acquireMegaNovelCdpLock(root,'target-1');throw new Error('claim should fail');}
      catch(error){if(error.code!=='EACCES')throw error;}
      fs.linkSync=link;
      ${owner}
    `);
    expect(result.outcome).toBe('acquired');
  });
  it('does not open a legacy claim window while replacing a crashed new marker', async () => {
    const root = await setup();
    const prior = await launch(root, owner);
    await kill(prior.child);
    const next = await launch(root, `
      const rename=fs.renameSync;
      fs.renameSync=(...args)=>{
        try{fs.closeSync(fs.openSync(root+'/target-1.lock','wx'));throw new Error('legacy stole marker');}
        catch(error){if(error.code!=='EEXIST')throw error;}
        return rename(...args);
      };
      ${owner}
    `);
    expect(next.outcome).toBe('acquired');
  });
  it('does not release the live owner when a failed same-process contender is collected', async () => {
    const root = await setup();
    acquire(root);
    expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
    const result = await launch(root, `
      let outcome;try{acquireMegaNovelCdpLock(root,'target-1');outcome='acquired';}
      catch(error){outcome=error.code;}process.send({outcome});setInterval(()=>{},1000);
    `);
    expect(result.outcome).toBe('MEGANOVEL_BROWSER_BUSY');
  });
  it('keeps active ownership strongly reachable when its caller drops all references', async () => {
    const root = await setup();
    await launch(root, `
      acquireMegaNovelCdpLock(root,'target-1');
      setImmediate(()=>{for(let i=0;i<10;i++)global.gc();process.send({});});setInterval(()=>{},1000);
    `);
    expect(() => acquire(root)).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
  });
  it('shares one lock through directory aliases while allowing different target IDs', async () => {
    const root = await setup(), alias = await setup();
    await symlink(root, join(alias, 'browser'), process.platform === 'win32' ? 'junction' : 'dir');
    acquire(root);
    expect(() => acquire(join(alias, 'browser'))).toThrow(expect.objectContaining({code: 'MEGANOVEL_BROWSER_BUSY'}));
    expect(() => acquire(root, 'target-2')).not.toThrow();
  });
});
