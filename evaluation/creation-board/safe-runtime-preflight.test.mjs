import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, chmod, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSafeRuntimePreflight, classifyNativeDiagnostic } from './safe-runtime-preflight.mjs';
import { createCodexAccountService, selectCodexModel } from '../../packages/core/dist/codex/account.js';
import { readCodexSettings } from '../../packages/core/dist/codex/settings.js';
import { resolveEffectiveLLMConfig } from '../../packages/core/dist/utils/effective-llm-config.js';

const dir = dirname(fileURLToPath(import.meta.url));
const roots = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const outputKeys = ['providerRoute', 'model', 'reasoningEffort', 'serviceTier', 'settingsSource', 'accountSource',
  'authPresent', 'authAvailable', 'catalogSupported', 'errorCode', 'runtime', 'studioContext'].sort();
const secret = 'secret-token-and-user@example.invalid';
const defaultSettings = { model: 'gpt-6.1-sol', reasoningEffort: 'ultra', serviceTier: 'priority' };
const defaultModel = { id: 'catalog-id', model: 'gpt-6.1-sol', displayName: 'Test', isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, { reasoningEffort: 'high' }],
  serviceTiers: [{ id: 'priority' }, { id: 'fast' }], token: secret };

async function fixture({ settings = defaultSettings, home = true, auth = true, env = {}, account, catalog, clientError, loadConfig } = {}) {
  const root = await mkdtemp(join(dir, '.safe-preflight-test-'));
  roots.push(root);
  const project = join(root, 'project');
  const cli = join(root, 'build/packages/cli/dist/index.js');
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, '// Never execute the selected CLI during preflight\n');
  await mkdir(join(project, '.inkos'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'inkos.json'), JSON.stringify({ name: 'Fixture', version: '0.1.0', language: 'en',
    llm: { service: 'legacy-provider', defaultModel: 'legacy-misleading-model', model: 'legacy-model', apiKey: secret },
    modelOverrides: { radar: { model: 'legacy-radar-model' } } }));
  if (settings !== null) await writeFile(join(project, '.inkos/codex-config.json'), JSON.stringify(settings));
  const codexHome = join(project, '.inkos/codex/home');
  if (home) {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    if (auth) await writeFile(join(codexHome, 'auth.json'), 'This is only a file-existence fixture; never parsed', { mode: 0o600 });
  }
  const events = [];
  const originalEnv = { ...process.env };
  const savedHome = process.env.INKOS_CODEX_HOME;
  const savedState = process.env.INKOS_CODEX_STATE_ROOT;
  delete process.env.INKOS_CODEX_HOME;
  delete process.env.INKOS_CODEX_STATE_ROOT;
  const core = { createCodexAccountService, selectCodexModel, readCodexSettings,
    loadLLMEnvLayers: async (root, clone) => {
      assert.notEqual(clone, process.env);
      events.push(['env', root]);
      const global = env.global ?? {}, project = env.project ?? {};
      Object.assign(clone, env.process ?? {});
      for (const [key, value] of Object.entries({ ...global, ...project })) if (clone[key] === undefined) clone[key] = value;
      return { global, project, process: clone };
    },
    resolveEffectiveLLMConfig: loadConfig ?? resolveEffectiveLLMConfig,
  };
  const appServer = {
    resolveCodexHome(project, options = {}) {
      return resolve(options.codexHome ?? join(options.stateRoot ?? join(project, '.inkos/codex'), 'home'));
    },
    async createCodexClient(project, options) {
      events.push(['launch', project, options]);
      if (clientError) throw clientError;
      return { cwd: '/mock-ephemeral-work', codexHome: options.codexHome, closed: false,
        async request(method, params) {
          events.push(['rpc', method, params]);
          if (method === 'account/read') return account ?? { account: { type: 'chatgpt', email: secret, planType: secret }, requiresOpenaiAuth: true };
          if (method === 'model/list') return catalog ?? { data: [defaultModel], nextCursor: null };
          throw new Error(`Unapproved RPC ${method}`);
        },
        onNotification() {}, onClose() {}, onRequest() {},
        async close() { events.push(['close']); },
      };
    },
  };
  const options = { cliPath: cli, projectRoot: project, expectModel: 'gpt-6.1-sol', expectEffort: 'ultra', expectTier: 'priority' };
  const run = async (overrides = {}, extraDependencies = {}) => {
    try {
      const value = await runSafeRuntimePreflight({ ...options, ...overrides }, { loadBuild: async () => ({ core, appServer }), ...extraDependencies });
      assert.deepEqual(Object.keys(value).sort(), outputKeys);
      assert.ok(!JSON.stringify(value).includes(secret));
      return value;
    } finally {
      if (savedHome === undefined) delete process.env.INKOS_CODEX_HOME; else process.env.INKOS_CODEX_HOME = savedHome;
      if (savedState === undefined) delete process.env.INKOS_CODEX_STATE_ROOT; else process.env.INKOS_CODEX_STATE_ROOT = savedState;
    }
  };
  return { root, project, cli, codexHome, events, core, appServer, options, run, originalEnv };
}

function rpcNames(f) { return f.events.filter(event => event[0] === 'rpc').map(event => event[1]); }

test('saved Codex settings and catalog beat legacy provider/defaultModel; only approved RPCs', async () => {
  const f = await fixture();
  const before = await readFile(join(f.project, 'inkos.json'), 'utf8');
  const result = await f.run();
  assert.equal(result.errorCode, null);
  assert.equal(result.providerRoute, 'codex-native-chatgpt');
  assert.equal(result.settingsSource, 'project-codex-config+core-defaults');
  assert.equal(result.accountSource, 'existing-project-codex-home');
  assert.equal(result.authPresent, true);
  assert.equal(result.authAvailable, true);
  assert.equal(result.catalogSupported, true);
  assert.deepEqual(rpcNames(f), ['account/read', 'model/list']);
  assert.deepEqual(f.events.find(event => event[1] === 'account/read')[2], { refreshToken: false });
  assert.equal(f.events.find(event => event[0] === 'launch')[2].codexHome, f.codexHome);
  assert.equal(f.events.at(-1)[0], 'close');
  assert.equal(await readFile(join(f.project, 'inkos.json'), 'utf8'), before);
});

test('missing home stops without creating directories or launching native runtime', async () => {
  const f = await fixture({ home: false });
  assert.equal((await f.run()).errorCode, 'CODEX_HOME_MISSING');
  await assert.rejects(access(f.codexHome));
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
});

test('missing auth file is metadata-only failure, with no account launch', async () => {
  const f = await fixture({ auth: false });
  const result = await f.run();
  assert.equal(result.errorCode, 'CODEX_AUTH_REQUIRED');
  assert.equal(result.authPresent, false);
  assert.equal(result.authAvailable, false);
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
});

test('saved settings override defaults and an exact expectation mismatch fails closed', async () => {
  const f = await fixture({ settings: { ...defaultSettings, reasoningEffort: 'high', serviceTier: 'fast' } });
  const result = await f.run();
  assert.equal(result.reasoningEffort, 'high');
  assert.equal(result.serviceTier, 'fast');
  assert.equal(result.errorCode, 'EXPECTED_EFFORT_MISMATCH');
});

test('missing settings use Core defaults without writing codex-config.json', async () => {
  const f = await fixture({ settings: null });
  const result = await f.run();
  assert.equal(result.errorCode, null);
  assert.equal(result.settingsSource, 'core-defaults');
  await assert.rejects(access(join(f.project, '.inkos/codex-config.json')));
});

test('explicit model:null reports the selected catalog model, never codex-default/defaultModel', async () => {
  const f = await fixture({ settings: { ...defaultSettings, model: null } });
  const result = await f.run();
  assert.equal(result.errorCode, null);
  assert.equal(result.model, 'gpt-6.1-sol');
});

test('unsupported model, effort, and tier use allowlisted Core error codes', async () => {
  for (const [settings, expected] of [
    [{ ...defaultSettings, model: 'missing-model' }, 'CODEX_MODEL_UNAVAILABLE'],
    [{ ...defaultSettings, reasoningEffort: 'low' }, 'CODEX_SETTINGS_UNSUPPORTED'],
    [{ ...defaultSettings, serviceTier: 'unsupported' }, 'CODEX_SETTINGS_UNSUPPORTED'],
  ]) {
    const f = await fixture({ settings });
    const result = await f.run();
    assert.equal(result.errorCode, expected);
    assert.equal(result.catalogSupported, false);
    assert.equal(f.events.at(-1)[0], 'close');
  }
});

test('unauthenticated account stops before catalog, never logins or refreshes', async () => {
  const f = await fixture({ account: { account: null, requiresOpenaiAuth: true } });
  const result = await f.run();
  assert.equal(result.errorCode, 'CODEX_AUTH_REQUIRED');
  assert.equal(result.authPresent, true);
  assert.equal(result.authAvailable, false);
  assert.deepEqual(rpcNames(f), ['account/read']);
});

test('raw errors and unknown error codes are not propagated', async () => {
  const f = await fixture({ clientError: Object.assign(new Error(secret), { code: secret }) });
  const result = await f.run();
  assert.equal(result.errorCode, 'CODEX_ACCOUNT_UNAVAILABLE');
  assert.equal(result.authAvailable, false);
});

test('malformed settings fail before native runtime launch', async () => {
  const f = await fixture({ settings: { model: secret, unexpectedSecret: secret } });
  assert.equal((await f.run()).errorCode, 'CODEX_SETTINGS_INVALID');
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
});

test('a non-Codex effective route refuses any account/catalog request', async () => {
  const f = await fixture({ loadConfig: async () => ({ llm: { service: 'legacy-http', provider: 'custom' }, diagnostics: {} }) });
  assert.equal((await f.run()).errorCode, 'PROVIDER_ROUTE_MISMATCH');
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
});

test('project env-file home is honored via cloned env and pinned, without mutating process.env', async () => {
  const f = await fixture({ home: false });
  const existing = join(f.root, 'authorized-app/home');
  await mkdir(existing, { recursive: true, mode: 0o700 });
  await writeFile(join(existing, 'auth.json'), 'unread-fixture');
  const before = process.env.INKOS_CODEX_HOME;
  f.core.loadLLMEnvLayers = async (root, clone) => {
    assert.notEqual(clone, process.env);
    clone.INKOS_CODEX_HOME = existing;
    return { global: { INKOS_CODEX_HOME: '/ignored-global' }, project: { INKOS_CODEX_HOME: existing }, process: clone };
  };
  const result = await f.run();
  assert.equal(result.errorCode, null);
  assert.equal(result.accountSource, 'project-env-inkos-codex-home');
  assert.equal(process.env.INKOS_CODEX_HOME, before);
  assert.equal(f.events.find(event => event[0] === 'launch')[2].codexHome, existing);
  await assert.rejects(access(f.codexHome));
});

test('personal CODEX_HOME is never a fallback', async () => {
  const f = await fixture({ home: false, env: { process: { CODEX_HOME: '/never-use-personal-account' } } });
  assert.equal((await f.run()).errorCode, 'CODEX_HOME_MISSING');
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
});

test('relative app-home override is rejected rather than resolving an unintended account', async () => {
  const f = await fixture({ env: { project: { INKOS_CODEX_HOME: './account' } } });
  assert.equal((await f.run()).errorCode, 'CODEX_HOME_INVALID');
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
});

test('symlinked home/auth file and nonprivate home are rejected without mutation', async () => {
  for (const kind of ['home-link', 'auth-link', 'home-permissions']) {
    const f = await fixture();
    if (kind === 'home-link') {
      await rm(f.codexHome, { recursive: true });
      const target = join(f.root, 'other-home');
      await mkdir(target, { mode: 0o700 });
      await symlink(target, f.codexHome);
    } else if (kind === 'auth-link') {
      const target = join(f.root, 'unread-auth');
      await writeFile(target, secret);
      await rm(join(f.codexHome, 'auth.json'));
      await symlink(target, join(f.codexHome, 'auth.json'));
    } else await chmod(f.codexHome, 0o755);
    const result = await f.run();
    assert.equal(result.errorCode, kind === 'auth-link' ? 'CODEX_AUTH_FILE_UNSAFE' : 'CODEX_HOME_UNSAFE');
    assert.equal(f.events.some(event => event[0] === 'launch'), false);
  }
});

test('exact model and tier guards return non-success despite a usable catalog', async () => {
  for (const [options, errorCode] of [[{ expectModel: 'wrong-model' }, 'EXPECTED_MODEL_MISMATCH'], [{ expectTier: 'fast' }, 'EXPECTED_TIER_MISMATCH']]) {
    const f = await fixture();
    assert.equal((await f.run(options)).errorCode, errorCode);
  }
});

test('CLI emits only allowlisted JSON for invalid arguments, no stack or usage leaks', () => {
  const child = spawnSync(process.execPath, [join(dir, 'safe-runtime-preflight.mjs'), '--cli', secret], { encoding: 'utf8' });
  assert.equal(child.status, 3);
  assert.equal(child.stderr, '');
  assert.deepEqual(Object.keys(JSON.parse(child.stdout)).sort(), outputKeys);
  assert.equal(JSON.parse(child.stdout).errorCode, 'INVALID_ARGUMENTS');
  assert.ok(!child.stdout.includes(secret));
});

// The subprocess exercises default paired-build resolution and output suppression.
// All runtime calls here are synthetic; this test never loads the native Codex binary.
test('selected-build subprocess refuses leaked diagnostics and uses only mocked account/catalog operations', async () => {
  const f = await fixture();
  const cliPackage = resolve(dirname(f.cli), '..');
  const corePackage = resolve(cliPackage, '../core');
  await writeFile(join(cliPackage, 'package.json'), JSON.stringify({ name: '@actalk/inkos', type: 'module' }));
  await mkdir(join(cliPackage, 'node_modules/@actalk'), { recursive: true });
  await mkdir(join(corePackage, 'dist/codex'), { recursive: true });
  await symlink(corePackage, join(cliPackage, 'node_modules/@actalk/inkos-core'));
  await writeFile(join(corePackage, 'package.json'), JSON.stringify({ name: '@actalk/inkos-core', type: 'module' }));
  const codexPackage = join(corePackage, 'node_modules/@openai/codex');
  await mkdir(join(codexPackage, 'bin'), { recursive: true });
  await writeFile(join(codexPackage, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.159.2', type: 'module' }));
  await writeFile(join(corePackage, 'dist/index.js'), `
    console.log(${JSON.stringify(secret)}); console.error(${JSON.stringify(secret)});
    export async function loadLLMEnvLayers(root, clone) { return {global:{}, project:{}, process:clone}; }
    export async function readCodexSettings() { return ${JSON.stringify(defaultSettings)}; }
    export async function resolveEffectiveLLMConfig() {return {llm:{service:'codex',provider:'openai'},diagnostics:{configMode:'codex'}};}
    export function selectCodexModel(models) {return models[0];}
    export function createCodexAccountService({projectDir,clientFactory}) {
      let client; return {
        async readAccount() {client=await clientFactory(projectDir);return client.request('account/read',{refreshToken:false});},
        async listModels() {return client.request('model/list',{});},
        async dispose() {await client?.close();}
      };
    }
  `);
  await writeFile(join(corePackage, 'dist/codex/app-server.js'), `
    import {join} from 'node:path';
    export const CODEX_APP_SERVER_VERSION='0.159.2';
    export function resolveCodexHome(project, options) {return options.codexHome??join(project,'.inkos/codex/home');}
    export async function createCodexClient(root, options) {return {
      codexHome: options.codexHome, cwd:root, closed:false,
      async request(method,params) {
        if(method==='account/read'&&params.refreshToken===false)return {connected:true,account:{type:'chatgpt',email:${JSON.stringify(secret)}}};
        if(method==='model/list')return [${JSON.stringify(defaultModel)}];
        throw Error(${JSON.stringify(secret)});
      }, onNotification(){},onClose(){},onRequest(){},async close(){}
    };}
  `);
  const child = spawnSync(process.execPath, [join(dir, 'safe-runtime-preflight.mjs'), '--cli', f.cli, '--project', f.project,
    '--expect-model', defaultSettings.model, '--expect-effort', 'ultra', '--expect-tier', 'priority'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stdout);
  assert.equal(child.stderr, '');
  assert.equal(JSON.parse(child.stdout).errorCode, null);
  assert.deepEqual(Object.keys(JSON.parse(child.stdout)).sort(), outputKeys);
  assert.ok(!child.stdout.includes(secret));
  assert.equal(JSON.parse(child.stdout).runtime.codexInstalledVersion, '0.159.2');
  await writeFile(join(codexPackage, 'bin/codex.js'), `process.stderr.write(${JSON.stringify(secret + ' unexpected argument --strict-config EROFS read-only file system')});process.exitCode=42;`);
  await writeFile(join(corePackage, 'dist/codex/app-server.js'), `
    import {spawn} from 'node:child_process'; import {join} from 'node:path';
    export const CODEX_APP_SERVER_VERSION='0.159.2';
    export function resolveCodexHome(project, options) {return options.codexHome??join(project,'.inkos/codex/home');}
    export async function createCodexClient() {
      const child=spawn(process.execPath,[${JSON.stringify(join(codexPackage, 'bin/codex.js'))},'app-server'],{stdio:['pipe','pipe','pipe']});
      child.stderr.resume();
      await new Promise(resolve=>child.once('close',resolve));
      throw Error(${JSON.stringify(secret)});
    }
  `);
  const failed = spawnSync(process.execPath, [join(dir, 'safe-runtime-preflight.mjs'), '--cli', f.cli, '--project', f.project], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(failed.status, 3);
  assert.equal(failed.stderr, '');
  const diagnostic = JSON.parse(failed.stdout);
  assert.equal(diagnostic.runtime.nativeSpawnObserved, true);
  assert.equal(diagnostic.runtime.exitCode, 42);
  assert.equal(diagnostic.runtime.signal, null);
  assert.equal(diagnostic.runtime.exitDuringShutdown, false);
  assert.deepEqual(diagnostic.runtime.diagnosticCategories.sort(), ['read-only-filesystem', 'unsupported-argument']);
  assert.ok(!failed.stdout.includes(secret));
});


test('diagnostic classifier emits only fixed categories and keeps unknown unknown', () => {
  assert.deepEqual(classifyNativeDiagnostic('EROFS Read-only file system ' + secret), ['read-only-filesystem']);
  assert.deepEqual(classifyNativeDiagnostic('Permission denied EACCES'), ['permission']);
  assert.deepEqual(classifyNativeDiagnostic('Cannot find module MODULE_NOT_FOUND'), ['runtime-dependency']);
  assert.deepEqual(classifyNativeDiagnostic('Failed to parse configuration'), ['config-rejected']);
  assert.deepEqual(classifyNativeDiagnostic(secret), []);
});

test('Studio PID context matches compare safely; no account identity is switched', async () => {
  const f = await fixture();
  const context = { executable: process.execPath, cwd: f.project, env: { ...process.env } };
  const result = await f.run({ studioPid: 123 }, { readStudioContext: async () => context });
  assert.equal(result.errorCode, null);
  assert.equal(result.studioContext.cwdMatches, true);
  assert.equal(result.studioContext.nodeExecutableMatches, true);
  assert.equal(result.studioContext.accountHomeMatches, true);
  assert.equal(result.studioContext.pathMatches, true);
  assert.equal(result.studioContext.runtimeEnvironmentMatches, true);
});

test('Studio home/PATH/executable differences fail before native launch and do not hide auth presence', async () => {
  for (const change of ['home', 'path', 'executable']) {
    const f = await fixture();
    const context = { executable: process.execPath, cwd: f.project, env: { ...process.env } };
    if (change === 'home') context.env.INKOS_CODEX_HOME = join(f.root, 'other-authorized-context');
    if (change === 'path') context.env.PATH = '/different-context';
    if (change === 'executable') context.executable = '/other/node';
    const result = await f.run({ studioPid: 123 }, { readStudioContext: async () => context });
    assert.equal(result.errorCode, 'STUDIO_LAUNCH_CONTEXT_MISMATCH');
    assert.equal(result.authPresent, true);
    assert.equal(result.authAvailable, false);
    assert.equal(f.events.some(event => event[0] === 'launch'), false);
  }
});

test('Studio cwd mismatch and unreadable proc context stop without probing another account', async () => {
  const f = await fixture();
  const result = await f.run({ studioPid: 123 }, { readStudioContext: async () => ({ executable: process.execPath, cwd: f.root, env: { ...process.env } }) });
  assert.equal(result.errorCode, 'STUDIO_LAUNCH_CONTEXT_MISMATCH');
  assert.equal(result.studioContext.cwdMatches, false);
  assert.equal(f.events.some(event => event[0] === 'launch'), false);
  const g = await fixture();
  const unavailable = await g.run({ studioPid: 123 }, { readStudioContext: async () => { throw Error(secret); } });
  assert.equal(unavailable.errorCode, 'STUDIO_CONTEXT_UNAVAILABLE');
  assert.equal(unavailable.studioContext.available, false);
});
