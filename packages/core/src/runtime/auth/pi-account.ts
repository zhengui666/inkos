import { randomUUID } from 'node:crypto';
import { PiAuthenticationOwner, PiLoginAdmissionError, type PiLoginTicket, type PiLoginSettlement } from './pi-owner.js';
import { assertPiLoginDeployment, loadPiOpenAIOAuth, loginPiNative, PiNativeLoginError, type PiLoginInteraction } from './pi-native-login.js';

export type PiAccountErrorCode = 'unknown-handle' | 'attempt-expired' | 'too-many-attempts' | 'scope-busy'
  | 'owner-changed' | 'context-changed' | 'prompt-not-current' | 'service-stopped' | 'sdk-unavailable' | 'device-settings-invalid' | 'login-deployment-unavailable' | 'login-failed' | 'storage-failed' | 'unsupported';
export type PiLoginStatus = 'reserved' | 'starting' | 'awaiting-user' | 'exchanging' | 'closing' | 'saved' | 'closed' | 'failed' | 'unknown';
export interface PiLoginChallenge { readonly kind: 'open-url'; readonly url: string }
/** Application correlation only; the official SDK does not issue this ID. */
export interface PiLoginPrompt { readonly promptId: string; readonly kind: 'callback-url' }
export interface PiLoginReply { readonly promptId: string; readonly callbackUrl: string }
export interface PiLoginAttempt {
  readonly harnessId: 'pi'; readonly handle: string; readonly status: PiLoginStatus;
  /** Server deadline for starting this reservation; it never cancels started work. */
  readonly expiresAt: number;
  readonly canReply: boolean; readonly challenge: Readonly<PiLoginChallenge> | null;
  readonly prompt: Readonly<PiLoginPrompt> | null; readonly error: PiAccountErrorCode | null;
}
export interface PiCloseResult { readonly outcome: 'closed' | 'already-committed' | 'unknown'; readonly attempt: PiLoginAttempt }
export interface PiLoginExpectation {
  readonly harnessId: 'pi'; readonly authContextRef: string; readonly connectionRef: string; readonly authGeneration: number;
}
export class PiAccountError extends Error {
  constructor(readonly code: PiAccountErrorCode) { super(code); this.name = 'PiAccountError'; }
}
interface Attempt {
  handle: string; expires: number; status: PiLoginStatus; expected: Readonly<PiLoginExpectation> | null;
  error: PiAccountErrorCode | null; challenge: string | null; controller: AbortController; closed: boolean;
  ticket?: Readonly<PiLoginTicket>; operation?: Promise<PiLoginSettlement>; settlement?: PiLoginSettlement; settledAt?: number;
  reply?: { promptId: string; resolve(value: string): void; reject(): void }; listeners: Set<(attempt: PiLoginAttempt) => void>;
}
// Scope exclusion is also persisted by the owner; this registry only rejects local competing starts.
const activeScopes = new Map<string, object>();
const reservedLifetimeMs = 5 * 60_000, recordLimit = 128;
// Match the Codex account receipt window, independently of UI listeners and reservations.
const receiptLifetimeMs = 10 * 60_000;
const terminal = (status: PiLoginStatus) => ['saved', 'closed', 'failed', 'unknown'].includes(status);

/** Host service: its opaque handles and pending challenge never become durable UI/history data. */
export class PiAccountService {
  private readonly records = new Map<string, Attempt>();
  private stopping = false;
  private disposePromise?: Promise<void>;
  private constructor(private readonly owner: PiAuthenticationOwner, private readonly deploymentFailure: PiNativeLoginError['code'] | null) {}
  static async create(projectRoot: string): Promise<PiAccountService> {
    const owner = await PiAuthenticationOwner.create(projectRoot); let failure: PiNativeLoginError['code'] | null = null;
    try { await loadPiOpenAIOAuth(); } catch (error) { failure = error instanceof PiNativeLoginError ? error.code : 'sdk-unavailable'; }
    return new PiAccountService(owner, failure);
  }
  /** A missing expectation means an observed absent owner, never an unconditional overwrite. */
  reserveLoginAttempt(expected: Readonly<PiLoginExpectation> | null = null): PiLoginAttempt {
    this.assertRunning();
    const now = Date.now();
    for (const [handle, record] of this.records) {
      if ((record.status === 'reserved' && record.expires <= now)
        || (record.settledAt !== undefined && record.settledAt + receiptLifetimeMs <= now)) this.records.delete(handle);
    }
    if (this.records.size >= recordLimit) throw new PiAccountError('too-many-attempts');
    const record: Attempt = { handle: `pi-login-${randomUUID()}`, expires: now + reservedLifetimeMs, status: 'reserved',
      expected: expected === null ? expected : Object.freeze({ harnessId: expected.harnessId,
        authContextRef: expected.authContextRef, connectionRef: expected.connectionRef, authGeneration: expected.authGeneration }),
      error: null, challenge: null, controller: new AbortController(), closed: false, listeners: new Set() };
    this.records.set(record.handle, record); return this.dto(record);
  }
  private get(handle: string): Attempt {
    const record = this.records.get(handle); if (!record) throw new PiAccountError('unknown-handle');
    if (record.status === 'reserved' && record.expires <= Date.now()) { this.records.delete(handle); throw new PiAccountError('attempt-expired'); }
    if (record.settledAt !== undefined && record.settledAt + receiptLifetimeMs <= Date.now()) {
      this.records.delete(handle); throw new PiAccountError('unknown-handle');
    }
    return record;
  }
  private assertRunning(): void { if (this.stopping) throw new PiAccountError('service-stopped'); }
  private finish(record: Attempt, status: PiLoginStatus): void {
    record.status = status; record.settledAt ??= Date.now();
  }
  private dto(record: Attempt): PiLoginAttempt {
    return Object.freeze({ harnessId: 'pi', handle: record.handle, status: record.status, expiresAt: record.expires, canReply: !!record.reply && !record.closed,
      challenge: record.challenge && !record.closed && !terminal(record.status) ? Object.freeze({ kind: 'open-url', url: record.challenge }) : null,
      prompt: record.reply && !record.closed && !terminal(record.status) ? Object.freeze({ promptId: record.reply.promptId, kind: 'callback-url' }) : null, error: record.error });
  }
  private publish(record: Attempt): void {
    const dto = this.dto(record);
    for (const listener of record.listeners) { try { listener(dto); } catch { /* Host notification must never throw into the OAuth flow. */ } }
  }
  readLoginAttempt(handle: string): PiLoginAttempt { return this.dto(this.get(handle)); }
  readLoginExpectation(): Readonly<PiLoginExpectation> | null {
    try { const target = this.owner.loginExpectation(); return target ? Object.freeze({ harnessId: 'pi',
      authContextRef: target.authContextRef, connectionRef: target.connectionRef, authGeneration: target.authGeneration }) : null;
    } catch { throw new PiAccountError('owner-changed'); }
  }
  /** Detach is UI lifetime only. It never closes OAuth, releases a ticket or deletes auth. */
  subscribeLoginAttempt(handle: string, listener: (attempt: PiLoginAttempt) => void): () => void {
    const record = this.get(handle); record.listeners.add(listener); return () => { record.listeners.delete(listener); };
  }
  disposeLoginAttempt(handle: string): void { this.get(handle).listeners.clear(); }
  replyLoginAttempt(handle: string, input: Readonly<PiLoginReply>): PiLoginAttempt {
    const record = this.get(handle);
    if (record.closed || !record.reply || !input || typeof input !== 'object' || input.promptId !== record.reply.promptId
      || typeof input.callbackUrl !== 'string' || input.callbackUrl.length > 16_384) throw new PiAccountError('prompt-not-current');
    const reply = record.reply; record.reply = undefined; reply.resolve(input.callbackUrl); this.publish(record); return this.dto(record);
  }
  private interaction(record: Attempt): PiLoginInteraction {
    return { signal: record.controller.signal,
      notify: event => {
        try {
          if (record.closed || terminal(record.status)) return;
          if (event.type === 'auth_url' && typeof event.url === 'string') {
            const url = new URL(event.url);
            if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize') return;
            record.challenge = event.url; record.status = 'awaiting-user';
          } else if (event.type === 'progress') record.status = 'exchanging';
          this.publish(record);
        } catch { /* Never leak event/cause or throw before the official cleanup finally. */ }
      },
      prompt: async request => {
        const signal = request.signal ?? record.controller.signal;
        if (request.type !== 'manual_code' || record.closed || signal.aborted || record.controller.signal.aborted) throw new DOMException('Pi login closed', 'AbortError');
        return new Promise<string>((resolve, reject) => {
          const aborted = () => finish(undefined);
          const finish = (value: string | undefined) => {
            signal.removeEventListener('abort', aborted); record.controller.signal.removeEventListener('abort', aborted);
            if (record.reply?.resolve === deliver) record.reply = undefined;
            value === undefined ? reject(new DOMException('Pi login closed', 'AbortError')) : resolve(value);
          };
          const deliver = (value: string) => finish(value);
          record.reply = { promptId: `pi-prompt-${randomUUID()}`, resolve: deliver, reject: aborted };
          signal.addEventListener('abort', aborted, { once: true }); record.controller.signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted || record.controller.signal.aborted) aborted(); else this.publish(record);
        });
      } };
  }
  startLoginAttempt(handle: string): PiLoginAttempt {
    this.assertRunning();
    const record = this.get(handle);
    if (record.status !== 'reserved') return this.dto(record);
    try { if (this.deploymentFailure) throw new PiNativeLoginError(this.deploymentFailure); assertPiLoginDeployment(); }
    catch (error) {
      this.finish(record, 'failed'); record.error = error instanceof PiNativeLoginError ? error.code : 'login-deployment-unavailable';
      this.publish(record); return this.dto(record);
    }
    const scope = this.owner.context.authContextRef;
    if (activeScopes.has(scope)) throw new PiAccountError('scope-busy');
    activeScopes.set(scope, record); record.status = 'starting';
    try { record.ticket = this.owner.beginLogin(record.expected); }
    catch (error) {
      activeScopes.delete(scope); this.finish(record, 'failed');
      record.error = error instanceof PiLoginAdmissionError ? error.reason === 'native-mutation-unsettled' ? 'scope-busy' : error.reason : 'storage-failed';
      this.publish(record); return this.dto(record);
    }
    try {
      record.operation = this.owner.runLogin(record.ticket, async () => {
        try { return await loginPiNative(this.owner.scope, this.interaction(record)); }
        catch (error) { if (error instanceof PiNativeLoginError) record.error = error.code; throw error; }
      }, record.controller.signal);
    } catch {
      activeScopes.delete(scope); this.finish(record, 'unknown'); record.error = 'owner-changed'; this.publish(record); return this.dto(record);
    }
    void record.operation.then(settlement => {
      record.settlement = settlement; record.challenge = null; record.reply?.reject(); record.reply = undefined;
      this.finish(record, settlement.outcome === 'saved' ? 'saved' : settlement.outcome === 'unknown' ? 'unknown' : record.closed ? 'closed' : 'failed');
      record.error ??= settlement.failure ?? null;
      if (activeScopes.get(scope) === record) activeScopes.delete(scope);
      this.publish(record);
    });
    this.publish(record); return this.dto(record);
  }
  async closeLoginAttempt(handle: string): Promise<PiCloseResult> {
    return this.closeRecord(this.get(handle));
  }
  private async closeRecord(record: Attempt): Promise<PiCloseResult> {
    // Latch synchronously before any await, including while PKCE/listener startup is pending.
    record.closed = true; record.challenge = null; record.reply?.reject();
    if (!terminal(record.status)) record.status = 'closing';
    let latchFailed = false;
    if (record.ticket && !record.settlement) { try { this.owner.closeLogin(record.ticket); } catch { latchFailed = true; } }
    record.controller.abort(new DOMException('Pi login closed', 'AbortError')); this.publish(record);
    const settled = record.operation ? await record.operation : undefined;
    if (!settled) this.finish(record, 'closed');
    const outcome = settled?.outcome === 'saved' ? 'already-committed' : latchFailed || settled?.outcome === 'unknown' ? 'unknown' : 'closed';
    this.publish(record); return Object.freeze({ outcome, attempt: this.dto(record) });
  }
  /** Host shutdown: stop admission, close only this service's attempts, then drain their actual work. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.stopping = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    // Cache before notifications so a reentrant host listener sees the same shutdown.
    this.disposePromise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const closing = Array.from(this.records.values(), record => this.closeRecord(record));
    void Promise.all(closing).then(() => resolve(), reject);
    return this.disposePromise;
  }
  /** Phase 2 provides login and Close only. No ticket or credential deletion. */
  logout(): never { throw new PiAccountError('unsupported'); }
}
