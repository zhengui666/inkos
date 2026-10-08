#!/usr/bin/env node
/**
 * Evaluation-only account/catalog check. Never starts an inference thread/turn.
 * App Server can write ephemeral/native runtime state in an EXISTING account home;
 * this is read-only at the account/catalog RPC level, not a filesystem no-write promise.
 * See safe-runtime-preflight.md before running against a live authorized account.
 */
import { lstat, realpath, readFile, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { constants } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROUTE = 'codex-native-chatgpt';
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const ERRORS = new Set([
  'INVALID_ARGUMENTS', 'CLI_BUILD_INVALID', 'CORE_BUILD_INVALID', 'PROJECT_NOT_FOUND',
  'CONFIG_READ_FAILED', 'CODEX_SETTINGS_INVALID', 'PROVIDER_ROUTE_MISMATCH',
  'CODEX_HOME_INVALID', 'CODEX_HOME_MISSING', 'CODEX_HOME_UNSAFE', 'CODEX_AUTH_REQUIRED',
  'CODEX_AUTH_FILE_UNSAFE', 'CODEX_ACCOUNT_UNAVAILABLE', 'CODEX_CATALOG_UNAVAILABLE',
  'CODEX_MODEL_UNAVAILABLE', 'CODEX_SETTINGS_UNSUPPORTED', 'EXPECTED_MODEL_MISMATCH',
  'EXPECTED_EFFORT_MISMATCH', 'EXPECTED_TIER_MISMATCH', 'CODEX_RPC_DISALLOWED',
  'CODEX_DISPOSE_FAILED', 'PREFLIGHT_FAILED', 'STUDIO_CONTEXT_UNAVAILABLE',
  'STUDIO_LAUNCH_CONTEXT_MISMATCH', 'CODEX_RUNTIME_DEPENDENCY',
]);
const failure = code => Object.assign(new Error(code), { code });
const safeCode = (error, fallback) => ERRORS.has(error?.code) ? error.code : fallback;
const safeId = value => typeof value === 'string' && SAFE_ID.test(value);
const emptyResult = () => ({
  providerRoute: null, model: null, reasoningEffort: null, serviceTier: null,
  settingsSource: null, accountSource: null,
  authPresent: false, authAvailable: false, catalogSupported: false, errorCode: null,
  runtime: {
    codexExpectedVersion: null, codexInstalledVersion: null, launcherPath: null,
    launcherSource: 'selected-core-pinned-package', nodeVersion: process.versions.node,
    nodeExecutable: process.execPath, nodeExecutableSource: 'preflight-process',
    pathSource: process.env.PATH === undefined ? 'absent' : 'preflight-process-env',
    nativeSpawnObserved: false, exitCode: null, signal: null, exitDuringShutdown: false,
    diagnosticCategories: [],
  },
  studioContext: { requested: false, available: false, cwdMatches: null,
    nodeExecutableMatches: null, accountHomeMatches: null, pathMatches: null,
    runtimeEnvironmentMatches: null, nodeExecutable: null, environmentSource: 'proc-startup-env+current-env-files' },
});

async function statOrNull(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Resolve only the built Core paired with this monorepo CLI; never PATH/global fallback. */
async function loadSelectedBuild(cliPath) {
  try {
    const cli = await realpath(cliPath);
    const cliDir = dirname(cli);
    if (dirname(cliDir) === cliDir || !cli.endsWith('/dist/index.js')) throw failure('CLI_BUILD_INVALID');
    const cliPackage = JSON.parse(await readFile(join(cliDir, '../package.json'), 'utf8'));
    if (cliPackage.name !== '@actalk/inkos') throw failure('CLI_BUILD_INVALID');
    const coreDir = resolve(cliDir, '../../core/dist');
    const corePackage = JSON.parse(await readFile(join(coreDir, '../package.json'), 'utf8'));
    if (corePackage.name !== '@actalk/inkos-core') throw failure('CORE_BUILD_INVALID');
    // Verify the dependency actually used by this CLI is the same selected Core.
    const linkedCore = await realpath(join(cliDir, '../node_modules/@actalk/inkos-core'));
    if (linkedCore !== await realpath(dirname(coreDir))) throw failure('CORE_BUILD_INVALID');
    const core = await import(pathToFileURL(join(coreDir, 'index.js')).href);
    const appServer = await import(pathToFileURL(join(coreDir, 'codex/app-server.js')).href);
    for (const name of ['createCodexAccountService', 'readCodexSettings', 'selectCodexModel', 'resolveEffectiveLLMConfig', 'loadLLMEnvLayers']) {
      if (typeof core[name] !== 'function') throw failure('CORE_BUILD_INVALID');
    }
    if (typeof appServer.resolveCodexHome !== 'function' || typeof appServer.createCodexClient !== 'function') {
      // Do not guess a legacy account location when an older build lacks its resolver.
      throw failure('CORE_BUILD_INVALID');
    }
    const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) ? value : null;
    const runtimeMetadata = { codexExpectedVersion: version(appServer.CODEX_APP_SERVER_VERSION),
      codexInstalledVersion: null, launcherPath: null };
    try {
      const require = createRequire(pathToFileURL(join(coreDir, 'codex/app-server.js')));
      const packagePath = require.resolve('@openai/codex/package.json');
      const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
      runtimeMetadata.codexInstalledVersion = version(pkg.version);
      runtimeMetadata.launcherPath = join(dirname(packagePath), 'bin/codex.js');
    } catch { /* Missing installed dependency stays explicit; never inspect PATH alternatives. */ }
    return { core, appServer, runtimeMetadata };
  } catch (error) { throw failure(safeCode(error, 'CLI_BUILD_INVALID')); }
}

function parseArgs(argv) {
  const names = new Map([
    ['--cli', 'cliPath'], ['--project', 'projectRoot'], ['--expect-model', 'expectModel'],
    ['--expect-effort', 'expectEffort'], ['--expect-tier', 'expectTier'], ['--studio-pid', 'studioPid'],
  ]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names.get(argv[i]);
    if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw failure('INVALID_ARGUMENTS');
    }
    options[key] = argv[i + 1];
  }
  return options;
}

function checkArguments(options) {
  if (options.studioPid !== undefined && !/^[1-9][0-9]{0,9}$/.test(String(options.studioPid))) throw failure('INVALID_ARGUMENTS');
  if (!isAbsolute(options.cliPath ?? '') || !isAbsolute(options.projectRoot ?? '')) throw failure('INVALID_ARGUMENTS');
  for (const key of ['expectModel', 'expectEffort', 'expectTier']) {
    if (options[key] !== undefined && !safeId(options[key])) throw failure('INVALID_ARGUMENTS');
  }
}

async function assertPrivateDirectory(path) {
  const info = await statOrNull(path);
  if (!info) throw failure('CODEX_HOME_MISSING');
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())))) throw failure('CODEX_HOME_UNSAFE');
}

// Only these launch-context values may be retained from /proc; never emit them.
const RUNTIME_ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
const PROC_ENV_KEYS = new Set([...RUNTIME_ENV_KEYS, 'INKOS_CODEX_HOME', 'INKOS_CODEX_STATE_ROOT']);
async function readStudioContext(pid, projectRoot) {
  if (process.platform !== 'linux') throw failure('STUDIO_CONTEXT_UNAVAILABLE');
  try {
    const executable = await readlink(`/proc/${pid}/exe`);
    const cwd = await readlink(`/proc/${pid}/cwd`);
    if (await realpath(cwd) !== await realpath(projectRoot)) return { executable, cwd, env: {} };
    const env = {};
    let key = '', value = '', inValue = false, keep = false;
    for await (const chunk of createReadStream(`/proc/${pid}/environ`)) {
      // Parse incrementally, discard unselected values byte-by-byte, and retain no raw dump.
      for (const byte of chunk) {
        if (byte === 0) {
          if (keep) env[key] = value;
          key = ''; value = ''; inValue = false; keep = false;
        } else if (!inValue && byte === 61) { inValue = true; keep = PROC_ENV_KEYS.has(key); }
        else if (!inValue) { if (key.length < 256) key += String.fromCharCode(byte); }
        else if (keep) {
          if (value.length > 1024 * 1024) throw failure('STUDIO_CONTEXT_UNAVAILABLE');
          value += String.fromCharCode(byte);
        }
      }
    }
    // Linux environment strings use UTF-8; preserve exact values for comparison only.
    for (const key of Object.keys(env)) env[key] = Buffer.from(env[key], 'latin1').toString('utf8');
    return { executable, cwd, env };
  } catch { throw failure('STUDIO_CONTEXT_UNAVAILABLE'); }
}

export function classifyNativeDiagnostic(chunk) {
  const text = String(chunk);
  const rules = [
    ['read-only-filesystem', /read.only file\s*system|EROFS/i],
    ['unsupported-argument', /unexpected argument|unrecognized (?:argument|option)|unknown (?:argument|option)|found argument.*wasn.t expected/i],
    ['config-rejected', /invalid config|error (?:loading|reading|parsing) (?:config|configuration)|failed to (?:load|parse) (?:config|configuration)|unknown (?:configuration|config)(?: field| key)/i],
    ['permission', /permission denied|operation not permitted|EACCES|EPERM/i],
    ['runtime-dependency', /cannot find module|module_not_found|ENOENT|no such file or directory|shared librar|GLIBC[_ ]|exec format error|dynamic linker/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function captureNativeSpawn(launcherPath, output) {
  const original = childProcess.spawn;
  let shuttingDown = false;
  childProcess.spawn = function (command, args, options) {
    const child = original.call(this, command, args, options);
    if (command !== process.execPath || args?.[0] !== launcherPath || args?.[1] !== 'app-server') return child;
    output.nativeSpawnObserved = true;
    const add = label => { if (!output.diagnosticCategories.includes(label)) output.diagnosticCategories.push(label); };
    child.stderr?.on('data', chunk => { for (const label of classifyNativeDiagnostic(chunk)) add(label); });
    child.once('error', error => {
      if (error.code === 'ENOENT') add('runtime-dependency');
      else if (['EACCES', 'EPERM'].includes(error.code)) add('permission');
      else if (error.code === 'EROFS') add('read-only-filesystem');
    });
    child.once('close', (code, signal) => {
      output.exitCode = Number.isInteger(code) ? code : null;
      output.signal = typeof signal === 'string' && Object.hasOwn(constants.signals, signal) ? signal : null;
      output.exitDuringShutdown = shuttingDown;
    });
    return child;
  };
  syncBuiltinESMExports();
  return { beginShutdown() { shuttingDown = true; }, restore() {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  } };
}

/** dependencies.loadBuild is for in-process mocked tests only, never a CLI override. */
export async function runSafeRuntimePreflight(options, dependencies = {}) {
  const result = emptyResult();
  let service;
  let stage = 'PREFLIGHT_FAILED';
  let nativeCapture;
  try {
    checkArguments(options);
    if (!(await statOrNull(options.cliPath))?.isFile()) throw failure('CLI_BUILD_INVALID');
    if (!(await statOrNull(options.projectRoot))?.isDirectory()
      || !(await statOrNull(join(options.projectRoot, 'inkos.json')))?.isFile()) throw failure('PROJECT_NOT_FOUND');
    const { core, appServer, runtimeMetadata } = await (dependencies.loadBuild ?? loadSelectedBuild)(options.cliPath);
    const projectRoot = resolve(options.projectRoot);
    if (runtimeMetadata) Object.assign(result.runtime, runtimeMetadata);

    // Match the selected CLI's actual global/project/process precedence, but hydrate
    // a clone, never process.env. Do not print or persist these potentially secret maps.
    stage = 'CONFIG_READ_FAILED';
    const originalEnv = { ...process.env };
    const envLayers = await core.loadLLMEnvLayers(projectRoot, { ...originalEnv });
    const effectiveEnv = envLayers.process;
    const explicitHome = effectiveEnv.INKOS_CODEX_HOME;
    const explicitStateRoot = effectiveEnv.INKOS_CODEX_STATE_ROOT;
    const sourceOf = key => originalEnv[key] !== undefined ? 'process'
      : envLayers.project[key] !== undefined ? 'project-env' : 'global-env';
    if ((explicitHome !== undefined && (!explicitHome || !isAbsolute(explicitHome)))
      || (!explicitHome && explicitStateRoot !== undefined && (!explicitStateRoot || !isAbsolute(explicitStateRoot)))) {
      throw failure('CODEX_HOME_INVALID');
    }
    const codexHome = appServer.resolveCodexHome(projectRoot, {
      ...(explicitHome ? { codexHome: explicitHome } : {}),
      ...(explicitStateRoot ? { stateRoot: explicitStateRoot } : {}),
    });
    if (!isAbsolute(codexHome)) throw failure('CODEX_HOME_INVALID');
    result.accountSource = explicitHome ? `${sourceOf('INKOS_CODEX_HOME')}-inkos-codex-home`
      : explicitStateRoot ? `${sourceOf('INKOS_CODEX_STATE_ROOT')}-inkos-state-root-home` : 'existing-project-codex-home';
    const auth = await statOrNull(join(codexHome, 'auth.json'));
    if (auth && (!auth.isFile() || auth.isSymbolicLink())) throw failure('CODEX_AUTH_FILE_UNSAFE');
    result.authPresent = Boolean(auth);
    if (options.studioPid !== undefined) {
      result.studioContext.requested = true;
      stage = 'STUDIO_CONTEXT_UNAVAILABLE';
      const studio = await (dependencies.readStudioContext ?? readStudioContext)(String(options.studioPid), projectRoot);
      result.studioContext.available = true;
      result.studioContext.nodeExecutable = studio.executable;
      result.studioContext.cwdMatches = await realpath(studio.cwd) === await realpath(projectRoot);
      result.studioContext.nodeExecutableMatches = studio.executable === await realpath(process.execPath);
      result.studioContext.pathMatches = studio.env.PATH === originalEnv.PATH;
      result.studioContext.runtimeEnvironmentMatches = RUNTIME_ENV_KEYS.every(key => studio.env[key] === originalEnv[key]);
      // Global env-file location is based on this process's HOME. A different HOME
      // cannot be compared by reusing that location, so fail rather than borrow it.
      if (!result.studioContext.cwdMatches || studio.env.HOME !== originalEnv.HOME) {
        throw failure('STUDIO_LAUNCH_CONTEXT_MISMATCH');
      }
      const studioLayers = await core.loadLLMEnvLayers(projectRoot, { ...studio.env });
      const studioEnv = studioLayers.process;
      const studioHome = studioEnv.INKOS_CODEX_HOME || join(studioEnv.INKOS_CODEX_STATE_ROOT || join(projectRoot, '.inkos/codex'), 'home');
      result.studioContext.accountHomeMatches = isAbsolute(studioHome) && resolve(studioHome) === resolve(codexHome);
      if (!result.studioContext.nodeExecutableMatches || !result.studioContext.accountHomeMatches
        || !result.studioContext.pathMatches || !result.studioContext.runtimeEnvironmentMatches) {
        throw failure('STUDIO_LAUNCH_CONTEXT_MISMATCH');
      }
    }

    await assertPrivateDirectory(dirname(codexHome));
    await assertPrivateDirectory(codexHome);
    stage = 'CODEX_SETTINGS_INVALID';
    result.settingsSource = await statOrNull(join(projectRoot, '.inkos/codex-config.json'))
      ? 'project-codex-config+core-defaults' : 'core-defaults';
    const settings = await core.readCodexSettings(projectRoot);
    if ((settings.model !== undefined && !safeId(settings.model))
      || !safeId(settings.reasoningEffort) || !safeId(settings.serviceTier)) throw failure('CODEX_SETTINGS_INVALID');
    result.model = settings.model ?? null;
    result.reasoningEffort = settings.reasoningEffort;
    result.serviceTier = settings.serviceTier;

    stage = 'CONFIG_READ_FAILED';
    // This is the CLI's production-text resolver, with the actual read-only env
    // layers. Legacy llm.defaultModel/provider/modelOverrides cannot select text routing.
    const effective = await core.resolveEffectiveLLMConfig({ consumer: 'cli', projectRoot,
      purpose: 'codex', requireApiKey: false, envLayers, cli: {} });
    if (effective.llm?.service !== 'codex' || effective.llm?.provider !== 'openai'
      || effective.diagnostics?.configMode !== 'codex') throw failure('PROVIDER_ROUTE_MISMATCH');
    result.providerRoute = ROUTE;
    if (!result.authPresent) throw failure('CODEX_AUTH_REQUIRED');

    stage = 'CODEX_ACCOUNT_UNAVAILABLE';
    if (runtimeMetadata) {
      if (!result.runtime.codexExpectedVersion || result.runtime.codexInstalledVersion !== result.runtime.codexExpectedVersion
        || !result.runtime.launcherPath) throw failure('CODEX_RUNTIME_DEPENDENCY');
      nativeCapture = captureNativeSpawn(result.runtime.launcherPath, result.runtime);
    }
    service = core.createCodexAccountService({ projectDir: projectRoot, clientFactory: async root => {
      // Repeat immediately before launch. Pin the exact verified home so no later env
      // hydration can choose another identity. The product owns ephemeral runtime writes.
      await assertPrivateDirectory(dirname(codexHome));
      await assertPrivateDirectory(codexHome);
      const client = await appServer.createCodexClient(root, { codexHome, requestTimeoutMs: 20_000 });
      return {
        cwd: client.cwd, codexHome: client.codexHome,
        get closed() { return client.closed; },
        request(method, params, requestOptions) {
          if (!['account/read', 'model/list'].includes(method)) throw failure('CODEX_RPC_DISALLOWED');
          if (method === 'account/read' && params?.refreshToken !== false) throw failure('CODEX_RPC_DISALLOWED');
          return client.request(method, params, requestOptions);
        },
        onNotification: listener => client.onNotification(listener),
        onClose: listener => client.onClose(listener),
        onRequest: listener => client.onRequest(listener),
        close: () => client.close(),
      };
    } });
    const account = await service.readAccount();
    result.authAvailable = account.connected === true && account.account?.type === 'chatgpt';
    if (!result.authAvailable) throw failure('CODEX_AUTH_REQUIRED');

    stage = 'CODEX_CATALOG_UNAVAILABLE';
    const selected = core.selectCodexModel(await service.listModels(), settings);
    if (!safeId(selected.model)) throw failure('CODEX_MODEL_UNAVAILABLE');
    result.model = selected.model; // Catalog-resolved runtime model, including explicit catalog-default.
    result.catalogSupported = true;
    if (options.expectModel !== undefined && result.model !== options.expectModel) throw failure('EXPECTED_MODEL_MISMATCH');
    if (options.expectEffort !== undefined && result.reasoningEffort !== options.expectEffort) throw failure('EXPECTED_EFFORT_MISMATCH');
    if (options.expectTier !== undefined && result.serviceTier !== options.expectTier) throw failure('EXPECTED_TIER_MISMATCH');
  } catch (error) { result.errorCode = safeCode(error, stage); }
  finally {
    if (service) {
      nativeCapture?.beginShutdown();
      try { await service.dispose(); }
      catch { result.errorCode ??= 'CODEX_DISPOSE_FAILED'; }
    }
    nativeCapture?.restore();
    if (['CODEX_ACCOUNT_UNAVAILABLE', 'CODEX_CATALOG_UNAVAILABLE'].includes(result.errorCode)
      && result.runtime.nativeSpawnObserved && result.runtime.diagnosticCategories.length === 0) {
      result.runtime.diagnosticCategories.push('unknown-runtime-failure');
    }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Emit exactly one allowlisted JSON record. Suppress dependency diagnostics rather
  // than attempting to redact secrets, account emails, raw configuration, or errors.
  const emit = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  let result;
  try { result = await runSafeRuntimePreflight(parseArgs(process.argv.slice(2))); }
  catch (error) { result = { ...emptyResult(), errorCode: safeCode(error, 'PREFLIGHT_FAILED') }; }
  emit(`${JSON.stringify(result)}\n`);
  process.exitCode = result.errorCode === null ? 0 : 3;
}
