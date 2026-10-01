import { createCodexClient, type CodexClient } from './app-server.js';
import { readCodexSettings, updateCodexSettings, validateCodexSettingsPatch } from './settings.js';
import type { CodexAccountStatus, CodexDeviceLogin, CodexLoginState, CodexModel, CodexSettings } from './types.js';

export type { CodexAccountStatus, CodexDeviceLogin, CodexLoginState, CodexModel } from './types.js';
export interface CodexAccountService {
  readAccount(): Promise<CodexAccountStatus>;
  startDeviceLogin(): Promise<CodexDeviceLogin>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  listModels(): Promise<CodexModel[]>;
  readSettings(): Promise<CodexSettings>;
  updateSettings(patch: unknown): Promise<CodexSettings>;
  dispose(): Promise<void>;
}
export interface CodexAccountServiceOptions {
  projectDir: string;
  clientFactory?: (projectDir: string) => Promise<CodexClient>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function projectModel(value: unknown): CodexModel | null {
  const model = object(value);
  if (!text(model.id) || !text(model.model) || model.hidden === true) return null;
  return {
    id: text(model.id), model: text(model.model), displayName: text(model.displayName),
    description: text(model.description), isDefault: model.isDefault === true,
    defaultReasoningEffort: text(model.defaultReasoningEffort),
    supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(value => {
      const effort = object(value); return { reasoningEffort: text(effort.reasoningEffort), description: text(effort.description) };
    }).filter(effort => effort.reasoningEffort),
    serviceTiers: projectServiceTiers(model),
    defaultServiceTier: typeof model.defaultServiceTier === 'string' ? model.defaultServiceTier : null,
  };
}

function projectServiceTiers(model: Record<string, unknown>): CodexModel["serviceTiers"] {
  const tiers = new Map<string, CodexModel["serviceTiers"][number]>();
  for (const value of Array.isArray(model.serviceTiers) ? model.serviceTiers : []) {
    const tier = object(value), id = text(tier.id);
    if (id) tiers.set(id, { id, name: text(tier.name) || id, description: text(tier.description) });
  }
  for (const id of Array.isArray(model.additionalSpeedTiers) ? model.additionalSpeedTiers : []) {
    if (typeof id === 'string' && id && !tiers.has(id)) tiers.set(id, { id, name: id, description: '' });
  }
  return [...tiers.values()];
}

export class CodexConfigurationError extends Error {
  constructor(readonly code: "CODEX_AUTH_REQUIRED" | "CODEX_MODEL_UNAVAILABLE" | "CODEX_SETTINGS_UNSUPPORTED", message: string) {
    super(message); this.name = "CodexConfigurationError";
  }
}

/** The runtime, settings editor and health check share the same catalog rules. */
export function selectCodexModel(models: readonly CodexModel[], settings: CodexSettings): CodexModel {
  const model = settings.model
    ? models.find(model => model.model === settings.model || model.id === settings.model)
    : models.find(model => model.isDefault) ?? models[0];
  if (!model) throw new CodexConfigurationError("CODEX_MODEL_UNAVAILABLE",
    "The configured Codex model is not available. Refresh Codex settings and choose an available model.");
  if (!model.supportedReasoningEfforts.some(option => option.reasoningEffort === settings.reasoningEffort)) {
    throw new CodexConfigurationError("CODEX_SETTINGS_UNSUPPORTED", "The configured reasoning effort is not supported by this Codex model. Update Codex settings.");
  }
  if (settings.serviceTier !== 'default' && !model.serviceTiers.some(option => option.id === settings.serviceTier)) {
    throw new CodexConfigurationError("CODEX_SETTINGS_UNSUPPORTED", "The configured speed is not supported by this Codex model. Update Codex settings.");
  }
  return model;
}

/** Read-only account/catalog validation, never a model inference or billing probe. */
export async function inspectCodexReadiness(service: Pick<CodexAccountService, 'readAccount' | 'readSettings' | 'listModels'>): Promise<{ model: string; reasoningEffort: string; serviceTier: string }> {
  const account = await service.readAccount();
  if (!account.connected || account.account?.type !== 'chatgpt') throw new CodexConfigurationError("CODEX_AUTH_REQUIRED",
    "Sign in with ChatGPT in Studio → Project settings → Codex before starting a text task.");
  const settings = await service.readSettings();
  const model = selectCodexModel(await service.listModels(), settings);
  return { model: model.model, reasoningEffort: settings.reasoningEffort, serviceTier: settings.serviceTier };
}

export async function readCodexModels(client: CodexClient, signal?: AbortSignal): Promise<CodexModel[]> {
  const models = new Map<string, CodexModel>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    signal?.throwIfAborted();
    const result = object(await client.request('model/list', { cursor, limit: 100, includeHidden: false }, { signal }));
    if (!Array.isArray(result.data)) throw new Error('Codex returned an invalid model catalog');
    for (const value of result.data) { const model = projectModel(value); if (model) models.set(model.id, model); }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (cursor && seen.has(cursor)) throw new Error('Codex model catalog repeated a page');
    if (cursor) seen.add(cursor);
    if (seen.size > 100) throw new Error('Codex model catalog has too many pages');
  } while (cursor);
  return [...models.values()];
}

function projectDeviceLogin(value: unknown): CodexDeviceLogin {
  const login = object(value);
  const url = new URL(text(login.verificationUrl));
  if (login.type !== 'chatgptDeviceCode' || !text(login.loginId) || !text(login.userCode)
    || url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)
    || url.username || url.password) throw new Error('Codex returned an invalid ChatGPT device login');
  return { type: 'chatgptDeviceCode', loginId: text(login.loginId), verificationUrl: url.toString(), userCode: text(login.userCode) };
}

export function createCodexAccountService(options: CodexAccountServiceOptions): CodexAccountService {
  return new AccountService(options);
}

class AccountService implements CodexAccountService {
  private clientPromise?: Promise<CodexClient>;
  private login: CodexLoginState | null = null;
  private earlyCompletions = new Map<string, boolean>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private options: CodexAccountServiceOptions) {}

  private async getClient(): Promise<CodexClient> {
    if (this.disposed) throw new Error('Codex account service is closed');
    if (!this.clientPromise) {
      const factory = this.options.clientFactory ?? createCodexClient;
      const promise = factory(this.options.projectDir).then(client => {
        client.onNotification((method, params) => this.notification(method, params));
        client.onClose(() => {
          if (this.clientPromise === promise) this.clientPromise = undefined;
          if (this.login?.status === 'pending') this.finishLogin(false, 'Codex disconnected before sign-in completed. Start sign-in again.');
        });
        return client;
      }).catch(error => { if (this.clientPromise === promise) this.clientPromise = undefined; throw error; });
      this.clientPromise = promise;
    }
    return this.clientPromise;
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'account/login/completed') return;
    const result = object(params);
    const id = text(result.loginId);
    if (this.login?.loginId === id && this.login.status === 'pending') this.finishLogin(result.success === true);
    else if (id) {
      // A notification can arrive in the same stream chunk as the login/start reply.
      if (this.earlyCompletions.size >= 8) this.earlyCompletions.clear();
      this.earlyCompletions.set(id, result.success === true);
    }
  }

  private finishLogin(success: boolean, error?: string): void {
    if (!this.login) return;
    this.login = { loginId: this.login.loginId, status: success ? 'completed' : 'failed',
      ...(!success ? { error: error ?? 'ChatGPT sign-in did not complete. The code may have expired; start sign-in again.' } : {}) };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next;
    return next;
  }

  async readAccount(): Promise<CodexAccountStatus> {
    const result = object(await (await this.getClient()).request('account/read', { refreshToken: false }));
    const raw = object(result.account);
    const account = raw.type === 'chatgpt' ? {
      type: 'chatgpt' as const, email: typeof raw.email === 'string' ? raw.email : null, planType: text(raw.planType) || 'unknown',
    } : null;
    return { connected: account !== null, account, requiresOpenaiAuth: result.requiresOpenaiAuth !== false,
      login: this.login ? { ...this.login } : null };
  }

  startDeviceLogin(): Promise<CodexDeviceLogin> {
    return this.exclusive(async () => {
      if (this.login?.status === 'pending' && this.login.verificationUrl && this.login.userCode) {
        return { type: 'chatgptDeviceCode', loginId: this.login.loginId, verificationUrl: this.login.verificationUrl, userCode: this.login.userCode };
      }
      const client = await this.getClient();
      let login: CodexDeviceLogin;
      try { login = projectDeviceLogin(await client.request('account/login/start', { type: 'chatgptDeviceCode' })); }
      catch (error) {
        // A timed-out or invalid start response must not leave an untracked login polling.
        await client.close();
        throw error;
      }
      this.login = { loginId: login.loginId, status: 'pending', verificationUrl: login.verificationUrl, userCode: login.userCode };
      if (this.earlyCompletions.has(login.loginId)) {
        this.finishLogin(this.earlyCompletions.get(login.loginId) === true);
        this.earlyCompletions.delete(login.loginId);
      }
      return login;
    });
  }

  cancelLogin(loginId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.login || loginId !== this.login.loginId) throw new Error('This sign-in attempt is no longer current');
      if (this.login.status !== 'pending') return;
      await (await this.getClient()).request('account/login/cancel', { loginId });
      // Completion may race cancellation; never overwrite an observed successful login.
      if (this.login?.status === 'pending') this.login = { loginId, status: 'cancelled' };
    });
  }

  logout(): Promise<void> {
    return this.exclusive(async () => {
      const client = await this.getClient();
      if (this.login?.status === 'pending') await client.request('account/login/cancel', { loginId: this.login.loginId });
      await client.request('account/logout', {});
      this.login = null; this.earlyCompletions.clear();
    });
  }

  async listModels(): Promise<CodexModel[]> {
    return readCodexModels(await this.getClient());
  }

  readSettings(): Promise<CodexSettings> { return readCodexSettings(this.options.projectDir); }

  updateSettings(value: unknown): Promise<CodexSettings> {
    return this.exclusive(async () => {
      const patch = validateCodexSettingsPatch(value);
      const current = await this.readSettings();
      const merged = { ...current, ...patch };
      selectCodexModel(await this.listModels(), { ...merged, model: merged.model ?? undefined });
      return updateCodexSettings(this.options.projectDir, patch);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Let already-started login/logout operations settle before stopping the polling process.
    try { await this.queue; } catch { /* Operation errors are returned to their callers. */ }
    const promise = this.clientPromise;
    this.clientPromise = undefined;
    if (promise) await (await promise).close();
    this.login = null; this.earlyCompletions.clear();
  }
}
