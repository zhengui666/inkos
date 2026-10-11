import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { inspectPiSdkInstallation, type PiCredentialStore } from './pi-native-store-compat.js';
import type { PiHostScope } from './pi-owner.js';

type Credential = NonNullable<Awaited<ReturnType<PiCredentialStore['read']>>>;
/** Mirrors the audited public provider signature; no browser-provided SDK options. */
export interface PiLoginInteraction {
  readonly signal: AbortSignal;
  prompt(request: { type: string; signal?: AbortSignal }): Promise<string>;
  notify(event: { type: string; url?: string }): void;
}
export class PiNativeLoginError extends Error {
  constructor(readonly code: 'sdk-unavailable' | 'device-settings-invalid' | 'login-deployment-unavailable') { super(code); this.name = 'PiNativeLoginError'; }
}
type OAuth = { login(interaction: PiLoginInteraction, options: { getDeviceId(): string }): Promise<Credential> };
const validDeviceId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
let approvedOAuth: OAuth | undefined, approval: Promise<OAuth> | undefined;
function assertConfiguredHost(): void {
  const value = process.env.PI_OAUTH_CALLBACK_HOST;
  if (process.versions.bun || typeof registerHooks !== 'function' || (value !== undefined && value !== '127.0.0.1')) {
    throw new PiNativeLoginError('login-deployment-unavailable');
  }
}
/** Synchronous start gate, before the owner writes a login ticket. */
export function assertPiLoginDeployment(): void {
  assertConfiguredHost();
  if (!approvedOAuth) throw new PiNativeLoginError('login-deployment-unavailable');
}
export async function loadPiOpenAIOAuth(): Promise<OAuth> {
  assertConfiguredHost();
  if (approvedOAuth) return approvedOAuth;
  return approval ??= approvePiOpenAIOAuth();
}
async function approvePiOpenAIOAuth(): Promise<OAuth> {
  try {
    const modules = await inspectPiSdkInstallation();
    const ai = modules.find(module => module.name === '@earendil-works/pi-ai' && module.importer === '@earendil-works/pi-coding-agent')!;
    const manifest = JSON.parse(await readFile(join(ai.root, 'package.json'), 'utf8'));
    if (manifest.exports?.['./providers/*']?.import !== './dist/providers/*.js') throw new Error();
    const entry = await realpath(join(ai.root, 'dist/providers/openai.js'));
    if (entry !== join(ai.root, 'dist/providers/openai.js')) throw new Error();
    const { openaiProvider } = await import(pathToFileURL(entry).href);
    if (typeof openaiProvider !== 'function') throw new Error();
    const provider = openaiProvider();
    if (provider.id !== 'openai' || typeof provider.auth?.oauth?.login !== 'function') throw new Error();
    const paths = ['dist/auth/oauth/load.js', 'dist/auth/oauth/openai-chatgpt.js', 'dist/utils/provider-env.js', 'dist/bun-oauth.js'];
    const urls = await Promise.all(paths.map(async path => {
      const resolved = await realpath(join(ai.root, path));
      if (resolved !== join(ai.root, path)) throw new Error();
      return pathToFileURL(resolved).href;
    }));
    const { getProviderEnvValue } = await import(urls[2]!);
    const checkHost = () => {
      assertConfiguredHost(); const value = getProviderEnvValue('PI_OAUTH_CALLBACK_HOST');
      if (value !== undefined && value !== '127.0.0.1') throw new PiNativeLoginError('login-deployment-unavailable');
    };
    checkHost(); let firstLoad = false;
    // This audited static entry has no top-level I/O or await. Do not call its registration
    // function. Synchronous ESM dependency loading checks the ESM cache before load hooks;
    // requiring the flow directly does not, and cannot prove that its host was not cached.
    const require = createRequire(import.meta.url);
    const hook = registerHooks({ load(url, context, next) {
      checkHost(); const result = next(url, context); checkHost();
      if (url === urls[1] && context.conditions.includes('import')
        && context.conditions.includes('module-sync') && !context.conditions.includes('require')) firstLoad = true;
      return result;
    } });
    try {
      require(fileURLToPath(urls[3]!)); checkHost();
    } catch {
      throw new PiNativeLoginError('login-deployment-unavailable');
    } finally { hook.deregister(); }
    if (!firstLoad) throw new PiNativeLoginError('login-deployment-unavailable');
    // The actual SDK lazy loader must return the same, now proven, official flow.
    const { loadOpenAIChatGPTOAuth } = await import(urls[0]!);
    const oauth = await loadOpenAIChatGPTOAuth();
    const official = (await import(urls[1]!)).openaiChatGPTOAuth; checkHost();
    if (oauth !== official || typeof oauth?.login !== 'function') {
      throw new PiNativeLoginError('login-deployment-unavailable');
    }
    return approvedOAuth = oauth as OAuth;
  } catch (error) {
    if (error instanceof PiNativeLoginError) throw error;
    throw new PiNativeLoginError('sdk-unavailable');
  }
}
/** Called after a persistent login ticket exists. Settings writes remain official and global. */
export async function loginPiNative(scope: Readonly<PiHostScope>, interaction: PiLoginInteraction): Promise<Credential> {
  interaction.signal.throwIfAborted();
  const oauth = await loadPiOpenAIOAuth(); interaction.signal.throwIfAborted();
  assertPiLoginDeployment();
  let deviceId: string;
  try {
    const settings = SettingsManager.create(scope.cwd, scope.agentDir, { projectTrusted: false });
    if (settings.drainErrors().length) throw new Error();
    const global = settings.getGlobalSettings();
    // The official getter treats falsy values as absent; existing invalid bytes must survive.
    if (Object.hasOwn(global, 'deviceId') && !validDeviceId(global.deviceId)) throw new Error();
    deviceId = settings.getOrCreateDeviceId();
    await settings.flush();
    if (settings.drainErrors().length || !validDeviceId(deviceId)) throw new Error();
  } catch { throw new PiNativeLoginError('device-settings-invalid'); }
  interaction.signal.throwIfAborted();
  assertPiLoginDeployment();
  // The approved official module retains its loopback constant even after environment changes.
  return oauth.login(interaction, { getDeviceId: () => deviceId });
}
