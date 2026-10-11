import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
const publicURL = pathToFileURL(resolve('dist/index.js')).href;
const sdkRoot = realpathSync('node_modules/@earendil-works/pi-coding-agent');
const flowURL = pathToFileURL(realpathSync(join(dirname(sdkRoot), 'pi-ai/dist/auth/oauth/openai-chatgpt.js'))).href;
const sdkURL = pathToFileURL(join(sdkRoot, 'dist/index.js')).href;
const code = String.raw`
import fs from 'node:fs/promises'; import net from 'node:net'; import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'; import { join } from 'node:path'; import { fileURLToPath } from 'node:url';
const role=process.argv[4], agent=process.env.PI_CODING_AGENT_DIR, project=process.argv[3];
const inventory=async()=>Object.fromEntries(await Promise.all((await fs.readdir(agent)).map(async name=>[name,await fs.readFile(join(agent,name),'utf8')])));
const before=await inventory(); let network=0, listens=0, settings=0, modify=0, binding=null;
globalThis.fetch=async()=>{network++;throw new Error('External OAuth network forbidden');};
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){listens++; if(args[1]!=='127.0.0.1') throw new Error('Unsafe bind blocked by fixture');
 this.once('listening',()=>{binding=this.address();}); return listen.apply(this,args);}; syncBuiltinESMExports();
if(role==='cached-unsafe'||role==='cached-safe'){await import(process.argv[2]);process.env.PI_OAUTH_CALLBACK_HOST='127.0.0.1';}
if(role==='cached-require-flow'||role==='cached-static-root'){
 createRequire(import.meta.url)(fileURLToPath(role==='cached-require-flow'?process.argv[2]:new URL('../../bun-oauth.js',process.argv[2])));
 process.env.PI_OAUTH_CALLBACK_HOST='127.0.0.1';
}
if(role==='cached-bundled'){(await import(new URL('../../bun-oauth.js',process.argv[2]).href)).registerBunOAuthFlows();}
if(role==='cached-loader-require'){
 await import(process.argv[2]);process.env.PI_OAUTH_CALLBACK_HOST='127.0.0.1';
 const rootURL=new URL('../../bun-oauth.js',process.argv[2]).href;
 registerHooks({load(url,context,next){if(url===rootURL)createRequire(import.meta.url)(fileURLToPath(process.argv[2]));return next(url,context);}});
}
const hostEvents=[];
if(role.startsWith('env-race-'))registerHooks({load(url,context,next){
 if(url===process.argv[2]){hostEvents.push('load:'+process.env.PI_OAUTH_CALLBACK_HOST);
  const later=(n,fn)=>n?queueMicrotask(()=>later(n-1,fn)):fn();
  later(Number(role.slice(9)),()=>{process.env.PI_OAUTH_CALLBACK_HOST='0.0.0.0';hostEvents.push('unsafe');
   queueMicrotask(()=>{process.env.PI_OAUTH_CALLBACK_HOST='127.0.0.1';hostEvents.push('safe');});});}
 return next(url,context);
}});
const {PiAccountService}=await import(process.argv[1]); const {SettingsManager}=await import(process.argv[5]);
const {AuthStorage}=await import(new URL('./core/auth-storage.js',process.argv[5]).href);
const device=SettingsManager.prototype.getOrCreateDeviceId; SettingsManager.prototype.getOrCreateDeviceId=function(...args){settings++;return device.apply(this,args);};
const save=AuthStorage.prototype.modify; AuthStorage.prototype.modify=function(...args){modify++;return save.apply(this,args);};
const services=role==='concurrent-create'?await Promise.all([PiAccountService.create(project),PiAccountService.create(project)]):[await PiAccountService.create(project)];
const service=services[0];
if(role==='changed-after-create')process.env.PI_OAUTH_CALLBACK_HOST='0.0.0.0';
let occupied;
if(role==='occupied'){occupied=net.createServer();await new Promise((resolve,reject)=>{occupied.once('error',reject);listen.call(occupied,1455,'127.0.0.1',resolve);});}
const attempt=service.reserveLoginAttempt(); let result, captured=false;
await new Promise(resolve=>{service.subscribeLoginAttempt(attempt.handle,dto=>{if(!captured&&(dto.canReply||['failed','unknown','closed'].includes(dto.status))){captured=true;result=dto;resolve();}});
 try{const dto=service.startLoginAttempt(attempt.handle);if(['failed','unknown','closed'].includes(dto.status)){captured=true;result=dto;resolve();}}catch(error){result={error:error.code};resolve();}});
const authorize=result.challenge?new URL(result.challenge.url):null;
await Promise.all(services.map(value=>value.dispose()));
const occupiedPreserved=occupied?.listening&&occupied.address()?.port===1455;
if(occupied)await new Promise(resolve=>occupied.close(resolve));
process.send({error:result.error,status:result.status,network,listens,settings,modify,binding,
 authorizeExpected:authorize?.origin==='https://auth.openai.com'&&authorize?.pathname==='/api/accounts/authorize',
 hostEvents,occupiedPreserved,services:services.length,bytesUnchanged:JSON.stringify(before)===JSON.stringify(await inventory()),authUnchanged:before['auth.json']===await fs.readFile(join(agent,'auth.json'),'utf8')});
process.disconnect();
`;
const dirs: string[] = [];
async function fixture(host: string | undefined, role = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'inkos-pi-deployment-')); dirs.push(dir);
  const project=join(dir,'project'),agent=join(dir,'agent'); await mkdir(project); await mkdir(agent);
  await writeFile(join(agent,'auth.json'), '{}');
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent };
  if (host === undefined) delete env.PI_OAUTH_CALLBACK_HOST; else env.PI_OAUTH_CALLBACK_HOST=host;
  return new Promise<Record<string, unknown>>((done, reject) => {
    const child=spawn(process.execPath,['--input-type=module','-e',code,publicURL,flowURL,project,role,sdkURL],{env,stdio:['ignore','pipe','pipe','ipc']});
    let stderr=''; child.stderr!.on('data', chunk=>{stderr+=chunk;}); let result: Record<string,unknown> | undefined;
    child.on('message', value=>{result=value as Record<string,unknown>;}); child.on('error',reject);
    child.on('exit', status=>status===0&&result?done(result):reject(new Error(`deployment fixture exit ${status}: ${stderr}`)));
  });
}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
describe('fresh-process official Pi deployment, no authorization endpoint visit or token request',()=>{
  it.each([undefined,'127.0.0.1'])('seam deployment: approved host %s really binds the official listener to 127.0.0.1:1455',async host=>{
    expect(await fixture(host)).toMatchObject({status:'awaiting-user',error:null,listens:1,binding:{address:'127.0.0.1',port:1455},authorizeExpected:true,network:0,modify:0,authUnchanged:true});
  });
  it.each(['0.0.0.0','::','localhost','192.0.2.1',''])('seam deployment: unsafe explicit host %j is refused before settings, listener or owner/auth mutation',async host=>{
    expect(await fixture(host)).toMatchObject({status:'failed',error:'login-deployment-unavailable',listens:0,settings:0,modify:0,network:0,bytesUnchanged:true});
  });
  it.each([['cached-unsafe','0.0.0.0'],['cached-safe','127.0.0.1'],['cached-require-flow','0.0.0.0'],['cached-static-root','0.0.0.0'],['cached-bundled','127.0.0.1'],['cached-loader-require','0.0.0.0'],['changed-after-create','127.0.0.1']])('seam deployment: %s cannot borrow current safe environment to approve an unproven or changed bind',async(role,host)=>{
    expect(await fixture(host,role)).toMatchObject({status:'failed',error:'login-deployment-unavailable',listens:0,settings:0,modify:0,network:0,bytesUnchanged:true});
  });
  it.each([6,15])('seam deployment: a transient microtask host change at depth %s cannot change the captured loopback bind',async depth=>{
    expect(await fixture('127.0.0.1',`env-race-${depth}`)).toMatchObject({status:'awaiting-user',error:null,listens:1,binding:{address:'127.0.0.1',port:1455},authorizeExpected:true,network:0,modify:0,authUnchanged:true,hostEvents:['load:127.0.0.1','unsafe','safe']});
  });
  it('seam deployment: concurrent service construction shares the same proven native flow',async()=>{
    expect(await fixture('127.0.0.1','concurrent-create')).toMatchObject({services:2,status:'awaiting-user',error:null,listens:1,binding:{address:'127.0.0.1',port:1455},network:0,authUnchanged:true});
  });
  it('seam deployment: occupied official port is preserved without changing the callback port',async()=>{
    expect(await fixture('127.0.0.1','occupied')).toMatchObject({status:'failed',error:'login-failed',listens:1,binding:null,occupiedPreserved:true,network:0,modify:0,authUnchanged:true});
  });
});
