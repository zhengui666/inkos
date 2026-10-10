import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexClient, type CodexClient } from './app-server.js';
import { readCodexSettings, updateCodexSettings, validateCodexSettingsPatch } from './settings.js';
import type { CodexAccountStatus, CodexDeviceLogin, CodexLoginState, CodexModel, CodexSettings } from './types.js';
import { CodexAuthenticationOwner, type CodexAuthOperation, type CodexConnectionStamp } from '../runtime/auth/codex-owner.js';

export type { CodexAccountStatus, CodexDeviceLogin, CodexLoginState, CodexModel } from './types.js';
/** expiresAt bounds an unused reservation; an active attempt retains its exact Close rights. */
export interface CodexDeviceLoginAttempt { readonly attemptHandle: string; readonly expiresAt: number }
export interface CodexDeviceLoginAttemptCloseResult {
  readonly attemptHandle: string;
  readonly state: 'closed' | 'already-terminal' | 'unknown-or-expired' | 'superseded';
  readonly cleanup: 'not-started' | 'cancel-acknowledged' | 'unconfirmed' | 'not-applicable';
}
export type CodexLoginAttemptErrorCode = 'CODEX_LOGIN_ATTEMPT_INVALID' | 'CODEX_LOGIN_ATTEMPT_UNKNOWN_OR_EXPIRED'
  | 'CODEX_LOGIN_ATTEMPT_CLOSED' | 'CODEX_LOGIN_ATTEMPT_BUSY' | 'CODEX_LOGIN_ATTEMPT_CAPACITY' | 'CODEX_LOGIN_ATTEMPT_FENCE_FAILED';
export class CodexLoginAttemptError extends Error {
  constructor(readonly code: CodexLoginAttemptErrorCode, options?: ErrorOptions) {
    super(code === 'CODEX_LOGIN_ATTEMPT_FENCE_FAILED' ? 'Could not durably close the sign-in attempt.'
      : code === 'CODEX_LOGIN_ATTEMPT_BUSY' ? 'The previous sign-in attempt has not settled.'
        : 'The sign-in attempt cannot be started.', options);
    this.name = 'CodexLoginAttemptError';
  }
}
export interface CodexAccountService {
  /** Server-only borrowed peer; the service retains lifecycle/close ownership. Never put it in a DTO. */
  getRuntimeClient(): Promise<CodexClient>;
  readAccount(): Promise<CodexAccountStatus>;
  /** Pure local metadata. Creates no peer, authentication owner or OAuth operation. */
  reserveDeviceLoginAttempt(): Readonly<CodexDeviceLoginAttempt>;
  /** Reusing a service-issued handle returns the same start promise, without replaying native login. */
  startDeviceLogin(options?: Readonly<{ attemptHandle: string }>): Promise<CodexDeviceLogin>;
  /** Accepts Close independently of caller transport lifetime; fences before best-effort exact native cleanup. */
  closeDeviceLoginAttempt(attemptHandle: string): Promise<CodexDeviceLoginAttemptCloseResult>;
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
  const matches = settings.model
    ? models.filter(model => model.model === settings.model || model.id === settings.model)
    : models.filter(model => model.isDefault);
  const model = matches.length === 1 ? matches[0] : undefined;
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

/** Account/catalog RPC validation, never inference. A cold service may start App Server and its runtime state. */
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

interface LoginAttempt {
  handle?: string;
  expiresAt: number;
  settledAt?: number;
  phase: 'reserved' | 'starting' | 'pending' | 'completed' | 'failed' | 'closed';
  closeRequested: boolean;
  dispatched: boolean;
  startSettled: boolean;
  settlementDone: boolean;
  readyCommitted: boolean;
  nativeTerminal: boolean;
  cleanupDone: boolean;
  cleanupAck: boolean;
  retired: boolean;
  peer?: CodexClient;
  peerPromise?: Promise<CodexClient>;
  owner?: CodexAuthenticationOwner;
  operation?: CodexAuthOperation;
  originalStamp?: CodexConnectionStamp;
  ownerSettledStamp?: CodexConnectionStamp;
  fenceStamp?: CodexConnectionStamp;
  fenceError?: CodexLoginAttemptError;
  fenceTried?: boolean;
  fenceDisposition?: 'closed' | 'already-terminal' | 'superseded';
  cleanupError?: unknown;
  login?: CodexDeviceLogin;
  start?: Promise<CodexDeviceLogin>;
  close?: Promise<CodexDeviceLoginAttemptCloseResult>;
}
const sameStamp = (a: CodexConnectionStamp | undefined, b: CodexConnectionStamp | undefined) => !!a && !!b
  && a.authContextRef === b.authContextRef && a.connectionRef === b.connectionRef && a.authGeneration === b.authGeneration
  && a.localState === b.localState && a.operationId === b.operationId;
const newAttempt = (handle?: string): LoginAttempt => ({ handle, expiresAt: Date.now() + 120_000,
  phase: 'reserved', closeRequested: false, dispatched: false, startSettled: true, settlementDone: true,
  readyCommitted: false, nativeTerminal: false, cleanupDone: true, cleanupAck: false, retired: false });

export function createCodexAccountService(options: CodexAccountServiceOptions): CodexAccountService {
  return new AccountService(options);
}

class AccountService implements CodexAccountService {
  private clientPromise?: Promise<CodexClient>;
  private login: CodexLoginState | null = null;
  private earlyCompletions = new Map<string, boolean>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private ownerLogin?: { owner: CodexAuthenticationOwner; operation: CodexAuthOperation; client: CodexClient };
  private ownerSettlement?: Promise<unknown>;
  private attempts = new Map<string, LoginAttempt>();
  private activeAttempt?: LoginAttempt;
  private peers = new Set<CodexClient>();
  private peerClosures = new WeakMap<CodexClient, { state: { succeeded: boolean }; promise: Promise<void> }>();
  private disposePromise?: Promise<void>;
  constructor(private options: CodexAccountServiceOptions) {}

  private async getClient(): Promise<CodexClient> {
    if (this.disposed) throw new Error('Codex account service is closed');
    if (!this.clientPromise) {
      const factory = this.options.clientFactory ?? createCodexClient;
      const promise = factory(this.options.projectDir).then(client => {
        this.peers.add(client);
        client.onNotification((method, params) => {
          if (!this.disposed && this.clientPromise === promise) this.notification(method, params);
        });
        client.onClose(() => {
          // Transport end is not process exit. Keep ownership until the one close settlement succeeds.
          void this.closePeer(client).catch(() => undefined);
          if (this.clientPromise === promise) {
            this.clientPromise = undefined;
            if (this.login?.status === 'pending') this.finishLogin(false, 'Codex disconnected before sign-in completed. Start sign-in again.', false);
          }
        });
        return client;
      }).catch(error => { if (this.clientPromise === promise) this.clientPromise = undefined; throw error; });
      this.clientPromise = promise;
    }
    return this.clientPromise;
  }

  private notification(method: string, params: unknown): void {
    if (method === 'account/updated') {
      void this.readAccount().catch(() => undefined);
      return;
    }
    if (method !== 'account/login/completed') return;
    const result = object(params);
    const id = text(result.loginId);
    const attempt = this.activeAttempt;
    if (attempt?.login?.loginId === id && attempt.closeRequested) {
      attempt.nativeTerminal = true;
      this.retireUnsettledTerminal(attempt);
      this.releaseAttempt(attempt);
      return;
    }
    if (this.login?.loginId === id && this.login.status === 'pending') this.finishLogin(result.success === true);
    else if (id) {
      // A notification can arrive in the same stream chunk as the login/start reply.
      if (this.earlyCompletions.size >= 8) this.earlyCompletions.clear();
      this.earlyCompletions.set(id, result.success === true);
    }
  }

  getRuntimeClient(): Promise<CodexClient> { return this.getClient(); }

  private finishLogin(success: boolean, error?: string, nativeTerminal = true): void {
    const attempt = this.activeAttempt;
    if (!attempt?.login || !attempt.owner || !attempt.operation || !attempt.peer
      || attempt.closeRequested || !attempt.settlementDone || this.disposed) return;
    attempt.settlementDone = false;
    if (nativeTerminal) attempt.nativeTerminal = true;
    const failed = () => {
      if (attempt.closeRequested || this.disposed) return;
      attempt.phase = 'failed';
      this.login = { loginId: attempt.login!.loginId, status: 'failed', error: error
        ?? 'ChatGPT sign-in did not complete. The code may have expired; start sign-in again.' };
    };
    const settle = async () => {
      if (success) {
        await attempt.owner!.completeLogin(attempt.operation!, attempt.peer!, state => {
          attempt.ownerSettledStamp = state;
          // The terminal boundary is the durable ready CAS, never the notification.
          if (state.localState === 'ready') {
            attempt.readyCommitted = true;
            attempt.phase = 'completed';
            this.login = { loginId: attempt.login!.loginId, status: 'completed' };
          }
        });
        if (!attempt.readyCommitted) failed();
      } else {
        attempt.owner!.complete(attempt.operation!, 'unknown', state => { attempt.ownerSettledStamp = state; });
        failed();
      }
    };
    this.ownerSettlement = settle().catch(error => { failed(); throw error; }).finally(() => {
      attempt.settlementDone = true;
      if (this.ownerLogin?.operation === attempt.operation) this.ownerLogin = undefined;
      this.retireUnsettledTerminal(attempt);
      this.releaseAttempt(attempt);
    });
    // Status and dispose still observe this settlement; background notification work must not reject unhandled.
    void this.ownerSettlement.catch(() => undefined);
  }

  private pruneAttempts(): void {
    const now = Date.now();
    for (const [handle, attempt] of this.attempts) {
      if (attempt === this.activeAttempt) continue;
      if ((attempt.phase === 'reserved' && now >= attempt.expiresAt)
        || (attempt.settledAt !== undefined && now - attempt.settledAt >= 600_000)) this.attempts.delete(handle);
    }
  }
  private releaseAttempt(attempt: LoginAttempt): void {
    if (!attempt.startSettled || !attempt.settlementDone || !attempt.cleanupDone) return;
    if (attempt.peer) {
      const closure = this.peerClosures.get(attempt.peer);
      if (closure) {
        if (!closure.state.succeeded) return;
        attempt.retired = true;
        this.peers.delete(attempt.peer);
        if (this.clientPromise === attempt.peerPromise) this.clientPromise = undefined;
      }
    }
    const ended = !attempt.dispatched || attempt.readyCommitted || attempt.cleanupAck || attempt.retired
      || (attempt.nativeTerminal && !!attempt.ownerSettledStamp && !attempt.closeRequested);
    if (!ended) return;
    attempt.settledAt ??= Date.now();
    if (this.activeAttempt === attempt) this.activeAttempt = undefined;
  }
  private retireUnsettledTerminal(attempt: LoginAttempt): void {
    if (!attempt.peer || !attempt.nativeTerminal || attempt.readyCommitted || !attempt.settlementDone || !attempt.cleanupDone) return;
    if (!attempt.ownerSettledStamp) {
      void this.closePeer(attempt.peer).catch(error => { attempt.cleanupError ??= error; });
    }
  }
  private closePeer(peer: CodexClient): Promise<void> {
    let closure = this.peerClosures.get(peer);
    if (!closure) {
      const state = { succeeded: false };
      const promise = Promise.resolve().then(() => peer.close()).then(() => {
        state.succeeded = true;
        this.peers.delete(peer);
        const attempt = this.activeAttempt;
        if (attempt?.peer === peer) {
          if (this.clientPromise === attempt.peerPromise) this.clientPromise = undefined;
          attempt.retired = true;
          this.releaseAttempt(attempt);
        }
      });
      closure = { state, promise };
      this.peerClosures.set(peer, closure);
      void promise.catch(() => undefined); // The owned set retains failed/pending peers for dispose.
    }
    return closure.promise;
  }
  private fence(attempt: LoginAttempt): 'closed' | 'already-terminal' | 'superseded' {
    if (attempt.readyCommitted) return 'already-terminal';
    if (!attempt.operation || !attempt.owner) return 'closed';
    if (attempt.fenceError) throw attempt.fenceError;
    if (attempt.fenceTried) return attempt.fenceDisposition!;
    attempt.fenceTried = true;
    if (attempt.fenceStamp) return 'closed';
    try {
      const won = attempt.owner.complete(attempt.operation, 'unknown', state => { attempt.fenceStamp = state; });
      if (won) return attempt.fenceDisposition = 'closed';
      const state = attempt.owner.snapshot();
      // An own non-ready settlement cleared this ticket; it is not another operation.
      if (attempt.ownerSettledStamp && state?.localState !== 'ready' && sameStamp(attempt.ownerSettledStamp, state)) {
        attempt.fenceStamp = attempt.ownerSettledStamp;
        return attempt.fenceDisposition = 'closed';
      }
      return attempt.fenceDisposition = 'superseded';
    } catch (cause) {
      attempt.fenceError ??= new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_FENCE_FAILED', { cause });
      throw attempt.fenceError;
    }
  }
  private checkStart(attempt: LoginAttempt): void {
    if (this.disposed || attempt.closeRequested) {
      this.fence(attempt);
      throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_CLOSED');
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next;
    return next;
  }

  async readAccount(): Promise<CodexAccountStatus> {
    try { await this.ownerSettlement; } catch { /* A failed settlement stays non-ready; a status read may still diagnose it. */ }
    const client = await this.getClient(), owner = new CodexAuthenticationOwner(client);
    const existing = () => existsSync(join(owner.context.home, 'inkos-connection.json')) ? owner.snapshot() : undefined;
    const before = existing();
    const result = object(await client.request('account/read', { refreshToken: false }));
    const after = existing();
    // A read begun before login/cancel/logout cannot publish or apply its stale account result.
    const unchanged = before?.authGeneration === after?.authGeneration && before?.operationId === after?.operationId
      && before?.connectionRef === after?.connectionRef && before?.localState === after?.localState && !client.closed;
    if (unchanged && before) owner.observe(client, result);
    const raw = unchanged ? object(result.account) : {};
    const account = raw.type === 'chatgpt' ? {
      type: 'chatgpt' as const, email: typeof raw.email === 'string' ? raw.email : null, planType: text(raw.planType) || 'unknown',
    } : null;
    return { connected: account !== null, account, requiresOpenaiAuth: result.requiresOpenaiAuth !== false,
      login: this.login ? { ...this.login } : null };
  }

  reserveDeviceLoginAttempt(): Readonly<CodexDeviceLoginAttempt> {
    if (this.disposed) throw new Error('Codex account service is closed');
    this.pruneAttempts();
    if (this.attempts.size >= 128) throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_CAPACITY');
    const attempt = newAttempt(randomUUID());
    this.attempts.set(attempt.handle!, attempt);
    return Object.freeze({ attemptHandle: attempt.handle!, expiresAt: attempt.expiresAt });
  }

  startDeviceLogin(options?: Readonly<{ attemptHandle: string }>): Promise<CodexDeviceLogin> {
    try {
      if (this.disposed) throw new Error('Codex account service is closed');
      this.pruneAttempts();
      let attempt: LoginAttempt;
      if (options !== undefined) {
        if (!options || typeof options !== 'object' || Object.keys(options).length !== 1
          || typeof options.attemptHandle !== 'string') throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_INVALID');
        const reserved = this.attempts.get(options.attemptHandle);
        if (!reserved) throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_UNKNOWN_OR_EXPIRED');
        if (reserved.closeRequested) throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_CLOSED');
        if (reserved.start) return reserved.start;
        attempt = reserved;
      } else {
        const active = this.activeAttempt;
        if (active && !active.handle && !active.closeRequested && (active.phase === 'starting' || active.phase === 'pending')) return active.start!;
        attempt = newAttempt();
      }
      if (this.activeAttempt) throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_BUSY');
      this.activeAttempt = attempt;
      attempt.phase = 'starting'; attempt.startSettled = false;
      attempt.start = this.exclusive(() => this.startAttempt(attempt));
      void attempt.start.then(() => { attempt.startSettled = true; this.releaseAttempt(attempt); },
        () => { attempt.startSettled = true; this.releaseAttempt(attempt); });
      return attempt.start;
    } catch (error) { return Promise.reject(error); }
  }

  private async startAttempt(attempt: LoginAttempt): Promise<CodexDeviceLogin> {
    try {
      this.checkStart(attempt);
      const client = await this.getClient();
      attempt.peer = client; attempt.peerPromise = this.clientPromise;
      this.checkStart(attempt);
      this.login = null; this.earlyCompletions.clear();
      const owner = attempt.owner = new CodexAuthenticationOwner(client);
      const operation = attempt.operation = owner.begin(true, state => { attempt.originalStamp = state; });
      this.ownerLogin = { owner, operation, client };
      this.checkStart(attempt);
      if (!sameStamp(attempt.originalStamp, owner.snapshot()) || this.clientPromise !== attempt.peerPromise || client.closed) {
        throw new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_BUSY');
      }
      attempt.dispatched = true;
      const login = attempt.login = projectDeviceLogin(await client.request('account/login/start', { type: 'chatgptDeviceCode' }));
      const early = this.earlyCompletions.get(login.loginId);
      this.earlyCompletions.delete(login.loginId);
      if (early !== undefined) attempt.nativeTerminal = true;
      if (attempt.closeRequested || this.disposed) {
        this.login = { loginId: login.loginId, status: 'cancelled' };
        this.checkStart(attempt);
      }
      attempt.phase = 'pending';
      this.login = { loginId: login.loginId, status: 'pending', verificationUrl: login.verificationUrl, userCode: login.userCode };
      if (early !== undefined) this.finishLogin(early);
      return login;
    } catch (error) {
      if (!attempt.closeRequested) {
        attempt.phase = 'failed';
        try { if (attempt.operation) attempt.owner!.complete(attempt.operation, 'unknown'); }
        catch (settlementError) { error = new AggregateError([error, settlementError], 'Sign-in start and settlement failed', { cause: error }); }
      }
      // A lost/invalid start has no exact ID to cancel. Retire only its original peer.
      if (attempt.dispatched && !attempt.login && attempt.peer) {
        try { await this.closePeer(attempt.peer); attempt.retired = true; }
        catch (cleanupError) { error = new AggregateError([error, cleanupError], 'Sign-in start and peer close failed', { cause: error }); }
      }
      if (!attempt.closeRequested && this.ownerLogin?.operation === attempt.operation) this.ownerLogin = undefined;
      throw error;
    }
  }

  closeDeviceLoginAttempt(handle: string): Promise<CodexDeviceLoginAttemptCloseResult> {
    if (this.disposed) return Promise.reject(new Error('Codex account service is closed'));
    this.pruneAttempts();
    const attempt = this.attempts.get(handle);
    if (!attempt) return Promise.resolve(Object.freeze({ attemptHandle: typeof handle === 'string' ? handle : '',
      state: 'unknown-or-expired', cleanup: 'not-applicable' }));
    return this.closeAttempt(attempt);
  }

  private closeAttempt(attempt: LoginAttempt): Promise<CodexDeviceLoginAttemptCloseResult> {
    if (attempt.close) return attempt.close;
    attempt.closeRequested = true;
    attempt.cleanupDone = false;
    let state: 'closed' | 'already-terminal' | 'superseded' = 'closed';
    let retirement: Promise<void> | undefined;
    try { state = this.fence(attempt); }
    catch { if (attempt.peer) { retirement = this.closePeer(attempt.peer); void retirement.catch(() => undefined); } }
    attempt.close = this.exclusive(async () => {
      let cleanup: CodexDeviceLoginAttemptCloseResult['cleanup'] = 'not-applicable';
      try {
        if (attempt.fenceError) {
          let cleanupError: unknown;
          try {
            if (!retirement && attempt.peer) retirement = this.closePeer(attempt.peer);
            if (retirement) { await retirement; attempt.retired = true; }
          }
          catch (error) { cleanupError = error; }
          throw cleanupError === undefined ? attempt.fenceError : new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_FENCE_FAILED',
            { cause: new AggregateError([attempt.fenceError.cause, cleanupError], 'Sign-in fence and original peer close failed') });
        }
        if (state === 'closed') {
          if (!attempt.dispatched) cleanup = 'not-started';
          else if (attempt.nativeTerminal && attempt.ownerSettledStamp
            && sameStamp(attempt.ownerSettledStamp, attempt.owner?.snapshot())) cleanup = 'not-applicable';
          else {
            cleanup = 'unconfirmed';
            const peer = attempt.peer, login = attempt.login;
            // No unrelated await, no peer creation and no new owner operation between this final check and exact-ID dispatch.
            if (peer && login && !peer.closed && this.clientPromise === attempt.peerPromise
              && this.activeAttempt === attempt && sameStamp(attempt.fenceStamp, attempt.owner?.snapshot())) {
              try {
                const response = object(await peer.request('account/login/cancel', { loginId: login.loginId }));
                if (response.status === 'canceled') { cleanup = 'cancel-acknowledged'; attempt.cleanupAck = true; }
              }
              catch (error) { attempt.cleanupError = error; }
            } else if (login && !attempt.retired) { state = 'superseded'; cleanup = 'not-applicable'; }
          }
        }
        return Object.freeze({ attemptHandle: attempt.handle ?? '', state, cleanup });
      } finally {
        attempt.cleanupDone = true;
        if (state === 'closed') {
          attempt.phase = 'closed';
          if (attempt.login) this.login = { loginId: attempt.login.loginId, status: 'cancelled' };
        }
        if (this.ownerLogin?.operation === attempt.operation) this.ownerLogin = undefined;
        this.retireUnsettledTerminal(attempt);
        this.releaseAttempt(attempt);
      }
    });
    return attempt.close;
  }

  cancelLogin(loginId: string): Promise<void> {
    const attempt = this.activeAttempt;
    if (attempt?.login?.loginId === loginId && this.login?.status === 'pending') {
      return this.closeAttempt(attempt).then(() => { if (attempt.cleanupError !== undefined) throw attempt.cleanupError; });
    }
    return this.exclusive(async () => {
      if (!this.login || loginId !== this.login.loginId) throw new Error('This sign-in attempt is no longer current');
      if (this.login.status !== 'pending') return;
      throw new Error('This sign-in attempt is no longer current');
    });
  }

  logout(): Promise<void> {
    return this.exclusive(async () => {
      const client = await this.getClient();
      const owner = new CodexAuthenticationOwner(client), operation = owner.begin();
      const attempt = this.activeAttempt;
      const pendingId = this.login?.status === 'pending' ? this.login.loginId : undefined;
      this.ownerLogin = undefined; this.login = null; this.earlyCompletions.clear();
      try {
        if (pendingId) await client.request('account/login/cancel', { loginId: pendingId });
        await client.request('account/logout', {});
        owner.complete(operation, 'disconnected');
        if (attempt) { attempt.nativeTerminal = true; this.releaseAttempt(attempt); }
      } catch (error) { owner.complete(operation, 'unknown'); throw error; }
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

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const pending = this.ownerLogin;
    const attempt = this.activeAttempt;
    if (attempt) attempt.closeRequested = true;
    this.ownerLogin = undefined;
    let settlementFailed = false, settlementError: unknown;
    try {
      if (pending && !attempt?.fenceTried) {
        if (attempt) attempt.fenceTried = true;
        const won = pending.owner.complete(pending.operation, 'unknown', state => { if (attempt) attempt.fenceStamp = state; });
        if (attempt) attempt.fenceDisposition = won ? 'closed' : attempt.readyCommitted ? 'already-terminal' : 'superseded';
      }
    } catch (error) {
      settlementFailed = true; settlementError = error;
      if (attempt) attempt.fenceError = new CodexLoginAttemptError('CODEX_LOGIN_ATTEMPT_FENCE_FAILED', { cause: error });
    }
    this.disposePromise = (async () => {
      try {
        // Native requests retain their existing bounded deadlines. Never skip cleanup after a failed drain/fence.
        try { await this.queue; } catch { /* Returned to the initiating caller. */ }
        try { await this.ownerSettlement; }
        catch (error) {
          if (!settlementFailed) { settlementFailed = true; settlementError = error; }
          else if (error !== settlementError) settlementError = new AggregateError([settlementError, error], 'Codex owner settlements failed');
        }
        if (settlementFailed) throw settlementError;
      } finally {
        const promise = this.clientPromise;
        this.clientPromise = undefined;
        const peers = new Set(this.peers), failures: unknown[] = [];
        try {
          if (promise) { try { peers.add(await promise); } catch (error) { failures.push(error); } }
          for (const peer of peers) { try { await this.closePeer(peer); } catch (error) { failures.push(error); } }
          if (failures.length) {
            if (settlementFailed) throw new AggregateError([settlementError, ...failures],
              'Codex login settlement and peer close both failed', { cause: settlementError });
            if (failures.length === 1) throw failures[0];
            throw new AggregateError(failures, 'Codex owned peers could not be closed');
          }
        } finally {
          this.login = null; this.earlyCompletions.clear(); this.ownerLogin = undefined;
          this.attempts.clear(); this.activeAttempt = undefined; this.peers.clear();
        }
      }
    })();
    return this.disposePromise;
  }
}
