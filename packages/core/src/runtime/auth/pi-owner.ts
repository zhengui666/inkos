import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { withBookLockGuard } from '../../state/book-lock-guard.js';
import type { ModelConnectionAdmission, RuntimeSelection } from '../contracts.js';
import { RuntimeAuthenticationError } from './codex-owner.js';
import { createPiNativeStoreCompat, inspectPiStoredOAuthSync, type PiCredentialStore } from './pi-native-store-compat.js';

export interface PiHostScope {
  readonly projectRoot: string; readonly cwd: string; readonly agentDir: string;
  readonly authPath: string; readonly projectTrusted: boolean;
}
/** Resolve missing suffixes without creating directories or reading a credential. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(absolute) === absolute) throw error;
    return join(canonical(dirname(absolute)), basename(absolute));
  }
}
/** Deployment paths come from the official Pi host setting, never an admission DTO. */
export function resolvePiHostScope(projectRoot: string): Readonly<PiHostScope> {
  const root = realpathSync(projectRoot), agentDir = canonical(getAgentDir());
  return Object.freeze({ projectRoot: root, cwd: root, agentDir, authPath: canonical(join(agentDir, 'auth.json')),
    // Inkos supplies all resources explicitly. It does not grant trust to ambient project extensions.
    projectTrusted: false });
}
const digest = (domain: string, value: string) => createHash('sha256').update(domain).update('\0').update(value).digest('hex');
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
}
type Credential = NonNullable<Awaited<ReturnType<PiCredentialStore['read']>>>;
function credentialRef(value: Credential | undefined): string {
  if (!value || value.type !== 'oauth' || typeof value.access !== 'string' || !value.access
    || typeof value.refresh !== 'string' || !value.refresh || !Number.isFinite(value.expires)) {
    throw new RuntimeAuthenticationError('Pi requires an existing ChatGPT OAuth credential');
  }
  return digest('inkos/pi/oauth-continuity/v1', JSON.stringify(sorted(value)));
}
const NativeMarkerSchema = z.object({
  kind: z.enum(['refresh', 'login']), operationId: z.string().min(1),
  authContextRef: z.string().min(1), connectionRef: z.string().min(1),
  authGeneration: z.number().int().positive().safe(),
}).strict();
const RefreshMarkerSchema = z.union([
  NativeMarkerSchema.extend({ kind: z.literal('refresh') }),
  // Existing markers remain blocking; only new operations issue full immutable tickets.
  z.object({ operationId: z.string().min(1), authGeneration: z.number().int().positive().safe() }).strict(),
]);
const RecordSchema = z.object({
  schemaVersion: z.literal(1), harnessId: z.literal('pi'), authContextRef: z.string().min(1),
  connectionRef: z.string().min(1), authGeneration: z.number().int().positive().safe(),
  localState: z.enum(['ready', 'unknown']), operationId: z.null(), credentialRef: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  pendingRefresh: RefreshMarkerSchema.optional(),
  pendingLogin: NativeMarkerSchema.extend({ kind: z.literal('login'), closed: z.boolean() }).optional(),
}).strict().superRefine((record, context) => {
  if ((record.pendingRefresh && record.pendingLogin) || (record.localState === 'ready' && (record.credentialRef === null || record.pendingLogin))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Pi native operation state' });
  }
});
type OwnerRecord = z.infer<typeof RecordSchema>;
export type PiAuthenticationTarget = Pick<RuntimeSelection, 'harnessId' | 'authContextRef' | 'connectionRef' | 'authGeneration'>;
/** Internal capability. Browser callers receive an unrelated service-local handle. */
export interface PiLoginTicket {
  readonly kind: 'login'; readonly operationId: string; readonly authContextRef: string;
  readonly connectionRef: string; readonly authGeneration: number; readonly startingCredentialRef: string | null;
}
export type PiLoginSettlement = Readonly<{ outcome: 'saved' | 'not-saved' | 'unknown'; closed: boolean;
  failure?: 'login-failed' | 'storage-failed' | 'owner-changed' }>;
/** Safe start-admission reasons; native mutation/fence algorithms retain their existing errors. */
export class PiLoginAdmissionError extends RuntimeAuthenticationError {
  constructor(readonly reason: 'native-mutation-unsettled' | 'owner-changed' | 'context-changed' | 'storage-failed') {
    super(reason); this.name = 'PiLoginAdmissionError';
  }
}
export interface PiExecutionLease {
  readonly credentials: PiCredentialStore;
  guard(signal?: AbortSignal): Promise<void>;
  resolveAuth<T>(resolve: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Includes native credential saving and metadata finalization, even after getAuth cancellation. */
  drain(): Promise<void>;
}
// Only exact promises registered by this process prove pending native work. No PID/recovery heuristic.
const mutations = new Map<string, Map<string, Promise<unknown>>>();
const refreshContexts = new AsyncLocalStorage<object>();

/** Private credential-continuity owner; it makes no claim about ChatGPT account identity. */
export class PiAuthenticationOwner {
  readonly context: Readonly<{ harnessId: 'pi'; authContextRef: string }>;
  private readonly path: string;
  private constructor(readonly scope: Readonly<PiHostScope>, private readonly native: PiCredentialStore, private readonly trusted: () => PiHostScope) {
    this.context = Object.freeze({ harnessId: 'pi', authContextRef: `pi-context-${digest('inkos/pi/context/v1', scope.authPath)}` });
    this.path = join(scope.agentDir, 'inkos-connection.json');
  }
  static async create(projectRoot: string): Promise<PiAuthenticationOwner> {
    const trusted = () => resolvePiHostScope(projectRoot), scope = trusted();
    return new PiAuthenticationOwner(scope, await createPiNativeStoreCompat(scope.authPath), trusted);
  }
  private assertContext(): void {
    try { if (JSON.stringify(this.trusted()) !== JSON.stringify(this.scope)) throw new Error(); }
    catch { throw new RuntimeAuthenticationError('The trusted Pi authentication context changed'); }
  }
  private readRecord(): OwnerRecord | undefined {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      const record = RecordSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (record.authContextRef !== this.context.authContextRef) throw new Error();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new RuntimeAuthenticationError('Cannot read the Pi connection record');
    }
  }
  private locked<T>(fn: () => T): T { return withBookLockGuard(this.path, fn); }
  private write(record: OwnerRecord): OwnerRecord {
    const next = RecordSchema.parse(record), temporary = join(this.scope.agentDir, `inkos-connection.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') { const directory = openSync(this.scope.agentDir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
      return next;
    } finally { rmSync(temporary, { force: true }); }
  }
  private matches(record: OwnerRecord | undefined, target: PiAuthenticationTarget): record is OwnerRecord {
    return !!record && record.localState === 'ready' && target.harnessId === 'pi'
      && record.authContextRef === target.authContextRef && record.connectionRef === target.connectionRef
      && record.authGeneration === target.authGeneration;
  }
  private fence(record: OwnerRecord): void {
    if (record.pendingRefresh || record.pendingLogin) throw new RuntimeAuthenticationError('Pi native mutation remains unsettled');
    this.write({ ...record, authGeneration: record.authGeneration + 1, localState: 'unknown' });
  }
  private admission(record: OwnerRecord): ModelConnectionAdmission {
    return { harnessId: 'pi', authContextRef: record.authContextRef,
      connection: { provider: 'chatgpt', authMethod: 'oauth', connectionRef: record.connectionRef },
      authGeneration: record.authGeneration, ready: record.localState === 'ready' && !record.pendingRefresh && !record.pendingLogin,
      readyReasons: record.pendingLogin ? ['login-pending'] : record.pendingRefresh ? ['refresh-pending'] : record.localState === 'ready' ? [] : ['unknown'] };
  }
  private async raw(): Promise<Credential | undefined> {
    this.assertContext();
    try { const value = await this.native.read('openai'); this.assertContext(); return value; }
    catch (error) {
      if (error instanceof RuntimeAuthenticationError) throw error;
      const failure = new RuntimeAuthenticationError('Cannot verify the Pi ChatGPT OAuth credential');
      Object.defineProperty(failure, 'cause', { value: error }); throw failure;
    }
  }
  private strictRef(): string | null {
    this.assertContext();
    // Native file locks are path based. An aliased auth file could otherwise
    // share credentials while splitting persistent owner/mutex locations.
    if (this.scope.authPath !== join(this.scope.agentDir, 'auth.json')) throw new RuntimeAuthenticationError('Pi login requires one canonical native storage scope');
    try { if (lstatSync(this.scope.authPath).nlink !== 1) throw new RuntimeAuthenticationError('Pi login requires an unaliased native auth file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const inspected = inspectPiStoredOAuthSync(this.scope.authPath);
    this.assertContext(); return inspected.credential ? credentialRef(inspected.credential) : null;
  }
  /** Read-only CAS evidence, including cold/unknown owners. It does not admit execution. */
  loginExpectation(): PiAuthenticationTarget | null {
    this.assertContext(); const record = this.readRecord();
    return record ? Object.freeze({ harnessId: 'pi', authContextRef: record.authContextRef,
      connectionRef: record.connectionRef, authGeneration: record.authGeneration }) : null;
  }
  private loginRecord(ticket: PiLoginTicket): OwnerRecord {
    this.assertContext(); const record = this.readRecord(), pending = record?.pendingLogin;
    if (!record || record.pendingRefresh || !pending || record.authContextRef !== ticket.authContextRef
      || record.connectionRef !== ticket.connectionRef || record.authGeneration !== ticket.authGeneration
      || record.credentialRef !== ticket.startingCredentialRef || pending.kind !== ticket.kind
      || pending.operationId !== ticket.operationId || pending.authContextRef !== ticket.authContextRef
      || pending.connectionRef !== ticket.connectionRef || pending.authGeneration !== ticket.authGeneration) {
      throw new RuntimeAuthenticationError('The Pi login ticket is no longer current');
    }
    return record;
  }
  /** Explicit start only: revoke prior execution, then hold exclusion through real settlement. */
  beginLogin(expected?: PiAuthenticationTarget | null): Readonly<PiLoginTicket> {
    try {
      this.assertContext(); const before = this.readRecord();
      if (before?.pendingRefresh || before?.pendingLogin) throw new PiLoginAdmissionError('native-mutation-unsettled');
      const ref = this.strictRef();
      if (expected === null ? !!before : expected !== undefined && (!before || expected.harnessId !== 'pi'
        || expected.authContextRef !== before.authContextRef || expected.connectionRef !== before.connectionRef
        || expected.authGeneration !== before.authGeneration)) throw new PiLoginAdmissionError('owner-changed');
      const ticket = Object.freeze({ kind: 'login' as const, operationId: randomUUID(), authContextRef: this.context.authContextRef,
        connectionRef: before?.connectionRef ?? `pi-connection-${randomUUID()}`, authGeneration: (before?.authGeneration ?? 0) + 1,
        startingCredentialRef: ref });
      mkdirSync(this.scope.agentDir, { recursive: true, mode: 0o700 });
      this.locked(() => {
        this.assertContext(); const current = this.readRecord();
        if (current?.pendingRefresh || current?.pendingLogin) throw new PiLoginAdmissionError('native-mutation-unsettled');
        if (JSON.stringify(current) !== JSON.stringify(before) || this.strictRef() !== ref) throw new PiLoginAdmissionError('owner-changed');
        const { startingCredentialRef: _private, ...marker } = ticket;
        try {
          this.write({ schemaVersion: 1, harnessId: 'pi', authContextRef: ticket.authContextRef, connectionRef: ticket.connectionRef,
            authGeneration: ticket.authGeneration, localState: 'unknown', operationId: null, credentialRef: ref,
            pendingLogin: { ...marker, closed: false } });
        } catch (error) {
          // A rename may be visible despite fsync failure. No OAuth/native work was started.
          try { const owned = this.loginRecord(ticket), { pendingLogin: _pending, ...rest } = owned; this.write(rest); } catch { /* Preserve unproven exclusion. */ }
          throw error;
        }
      });
      return ticket;
    } catch (error) {
      if (error instanceof PiLoginAdmissionError) throw error;
      try { this.assertContext(); } catch { throw new PiLoginAdmissionError('context-changed'); }
      throw new PiLoginAdmissionError('storage-failed');
    }
  }
  /** Close latches before aborting the same controller; it never releases exclusion. */
  closeLogin(ticket: PiLoginTicket): void {
    this.locked(() => { const current = this.loginRecord(ticket);
      if (!current.pendingLogin!.closed) this.write({ ...current, pendingLogin: { ...current.pendingLogin!, closed: true } });
    });
  }
  runLogin(ticket: PiLoginTicket, authenticate: () => Promise<Credential>, signal: AbortSignal): Promise<PiLoginSettlement> {
    this.loginRecord(ticket);
    let pending = mutations.get(this.context.authContextRef);
    if (!pending) { pending = new Map(); mutations.set(this.context.authContextRef, pending); }
    if (pending.has(ticket.operationId)) throw new RuntimeAuthenticationError('Pi login has already started');
    let candidateRef: string | undefined, committedCandidate: OwnerRecord | undefined, saving = false, phase: 'login-failed' | 'storage-failed' = 'login-failed';
    const settle = (outcome: PiLoginSettlement['outcome'], failure?: PiLoginSettlement['failure']): PiLoginSettlement => this.locked(() => {
      const record = this.loginRecord(ticket), closed = record.pendingLogin!.closed;
      if (outcome === 'saved' && this.strictRef() !== candidateRef) throw new RuntimeAuthenticationError('Pi saved login could not be verified');
      const { pendingLogin: _pending, ...rest } = record;
      const next = RecordSchema.parse({ ...rest, credentialRef: outcome === 'saved' ? candidateRef! : rest.credentialRef,
        localState: outcome === 'saved' ? 'ready' : 'unknown' });
      if (outcome === 'saved') committedCandidate = next;
      this.write(next);
      return Object.freeze({ outcome, closed, ...(failure ? { failure } : {}) });
    });
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted(); const credential = await authenticate(); candidateRef = credentialRef(credential);
      signal.throwIfAborted(); this.assertContext(); this.loginRecord(ticket); phase = 'storage-failed';
      saving = true;
      const saved = await this.native.modify('openai', async current => {
        signal.throwIfAborted(); this.assertContext();
        this.locked(() => { const record = this.loginRecord(ticket);
          if (record.pendingLogin!.closed || this.strictRef() !== ticket.startingCredentialRef
            || (current ? credentialRef(current) : null) !== ticket.startingCredentialRef) throw new RuntimeAuthenticationError('Pi OAuth changed before the login save');
        });
        return credential;
      }, { signal });
      if (credentialRef(saved) !== candidateRef) throw new RuntimeAuthenticationError('Pi native login save returned a different credential');
      return settle('saved');
    }).catch(() => {
      // Only this actual OAuth+native Promise can settle its ticket. Never recover another operation.
      try {
        if (committedCandidate) {
          this.locked(() => { this.assertContext(); const current = this.readRecord();
            if (JSON.stringify(current) === JSON.stringify(committedCandidate)) this.fence(current!);
          });
          return Object.freeze({ outcome: 'unknown' as const, closed: signal.aborted, failure: 'storage-failed' as const });
        }
        const actual = this.strictRef();
        const outcome = !saving ? 'not-saved' : actual === ticket.startingCredentialRef ? 'not-saved' : 'unknown';
        return settle(outcome, phase);
      } catch { return Object.freeze({ outcome: 'unknown' as const, closed: signal.aborted, failure: 'owner-changed' as const }); }
    });
    pending.set(ticket.operationId, operation);
    void operation.finally(() => { pending!.delete(ticket.operationId); if (!pending!.size) mutations.delete(this.context.authContextRef); }).catch(() => {});
    return operation;
  }
  /** Read-only observation: no owner, auth, config, directory or mutex creation. */
  async observe(): Promise<ModelConnectionAdmission | null> {
    this.assertContext();
    const before = this.readRecord();
    let ref: string;
    try { ref = credentialRef(await this.raw()); } catch { return null; }
    const after = this.readRecord();
    if (!after || JSON.stringify(before) !== JSON.stringify(after) || after.credentialRef !== ref) return null;
    return this.admission(after);
  }
  /** Passive envelope binds offline inspection to unchanged raw credential/owner evidence. */
  async probe<T>(inspect: (owner: ModelConnectionAdmission | null) => Promise<T>): Promise<T> {
    const before = this.readRecord(), first = credentialRef(await this.raw());
    if (before && (!this.admission(before).ready || before.credentialRef !== first)) throw new RuntimeAuthenticationError('Pi owner is not ready for observation');
    const value = await inspect(before ? this.admission(before) : null), last = credentialRef(await this.raw()), after = this.readRecord();
    if (first !== last || JSON.stringify(before) !== JSON.stringify(after)) throw new RuntimeAuthenticationError('Pi authentication changed during observation');
    return value;
  }
  private async observationCredential(): Promise<Credential | undefined> {
    const value = await this.raw();
    if (value) return value;
    this.assertContext();
    try {
      // The official one-off reader swallows JSON/I/O errors. Only absence in a
      // readable object (or ENOENT) proves missing; never expose its raw contents.
      const stored: unknown = JSON.parse(readFileSync(this.scope.authPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored) || Object.hasOwn(stored, 'openai')) throw new Error();
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new RuntimeAuthenticationError('Cannot observe the Pi ChatGPT OAuth storage');
    }
  }
  /** Missing/unknown observations never admit, fence, acquire a lock or create storage. */
  async observeSnapshot<T>(inspect: () => Promise<T>, signal?: AbortSignal): Promise<Readonly<{
    authContextRef: string | null; authentication: 'missing' | 'oauth-present' | 'unknown';
    owner: ModelConnectionAdmission | null; value: T | null;
  }>> {
    const unknown = () => {
      let authContextRef: string | null = null;
      try { this.assertContext(); authContextRef = this.context.authContextRef; } catch { /* Changed trust has no publishable scope. */ }
      return { authContextRef, authentication: 'unknown' as const, owner: null, value: null };
    };
    signal?.throwIfAborted();
    try {
      this.assertContext();
      const before = this.readRecord(), first = await this.observationCredential();
      signal?.throwIfAborted();
      if (before && (!this.admission(before).ready || (first && before.credentialRef !== credentialRef(first)))) return unknown();
      if (!first) {
        const last = await this.observationCredential(), after = this.readRecord();
        signal?.throwIfAborted(); this.assertContext();
        if (last || JSON.stringify(before) !== JSON.stringify(after)) return unknown();
        return { authContextRef: this.context.authContextRef, authentication: 'missing', owner: null, value: null };
      }
      const firstRef = credentialRef(first);
      // Capture the sanitized owner inside the original full-record/credential envelope.
      const result = await this.probe(async owner => {
        signal?.throwIfAborted();
        let value: T | null = null;
        try { value = await inspect(); } catch { signal?.throwIfAborted(); }
        signal?.throwIfAborted(); return { owner, value };
      });
      const last = await this.observationCredential(), after = this.readRecord();
      signal?.throwIfAborted(); this.assertContext();
      if (!last || firstRef !== credentialRef(last) || JSON.stringify(before) !== JSON.stringify(after)) return unknown();
      return { authContextRef: this.context.authContextRef, authentication: 'oauth-present', ...result };
    } catch { signal?.throwIfAborted(); return unknown(); }
  }
  async drain(): Promise<void> {
    for (;;) { const work = [...(mutations.get(this.context.authContextRef)?.values() ?? [])]; if (!work.length) return; await Promise.allSettled(work); }
  }
  /** A fresh top-level execution can establish continuity from an existing raw OAuth credential. */
  async admit(signal?: AbortSignal): Promise<ModelConnectionAdmission> {
    signal?.throwIfAborted(); this.assertContext();
    const observed = this.readRecord();
    if (observed?.pendingRefresh || observed?.pendingLogin) throw new RuntimeAuthenticationError('Pi native mutation remains unsettled');
    await this.drain(); signal?.throwIfAborted();
    const ref = credentialRef(await this.raw());
    const record = this.locked(() => {
      this.assertContext(); const current = this.readRecord();
      if (current?.pendingRefresh || current?.pendingLogin) throw new RuntimeAuthenticationError('Pi native mutation remains unsettled');
      if (!current) return this.write({ schemaVersion: 1, harnessId: 'pi', authContextRef: this.context.authContextRef,
        connectionRef: `pi-connection-${randomUUID()}`, authGeneration: 1, localState: 'ready', operationId: null, credentialRef: ref });
      return current.localState === 'ready' && current.credentialRef === ref ? current
        : this.write({ ...current, authGeneration: current.localState === 'ready' ? current.authGeneration + 1 : current.authGeneration,
          localState: 'ready', credentialRef: ref });
    });
    const admission = this.admission(record);
    await this.guard({ harnessId: 'pi', authContextRef: admission.authContextRef, connectionRef: admission.connection.connectionRef, authGeneration: admission.authGeneration }, signal);
    return admission;
  }
  private check(target: PiAuthenticationTarget, ref?: string): void {
    this.assertContext();
    // Unknown/foreign work is rejected before entering a metadata mutex. A Map
    // without that Promise is not evidence that the native write has finished.
    const observed = this.readRecord();
    if (!this.matches(observed, target) || observed.pendingRefresh || observed.pendingLogin) throw new RuntimeAuthenticationError('The Pi connection is not available for execution');
    this.locked(() => {
      const current = this.readRecord();
      if (!this.matches(current, target) || current.pendingRefresh || current.pendingLogin) throw new RuntimeAuthenticationError('The Pi connection is no longer admitted');
      if (ref === undefined || current.credentialRef !== ref) {
        this.fence(current); throw new RuntimeAuthenticationError('Pi OAuth credential continuity changed');
      }
    });
  }
  async guard(target: PiAuthenticationTarget, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      // Login already revoked the execution generation. Do not wait for a
      // human prompt before delivering that revocation to an old execution.
      this.assertContext(); if (this.readRecord()?.pendingLogin) this.check(target);
      await this.drain(); signal?.throwIfAborted();
      let ref: string | undefined;
      try { ref = credentialRef(await this.raw()); } catch { /* Missing/invalid credentials revoke this generation. */ }
      if (mutations.get(this.context.authContextRef)?.size) continue;
      this.check(target, ref); signal?.throwIfAborted(); return;
    }
  }
  lease(target: PiAuthenticationTarget): PiExecutionLease {
    const capability = {}, owner = this;
    let terminalAuth: RuntimeAuthenticationError | undefined, mutationFailure: RuntimeAuthenticationError | undefined, failureDelivered = false;
    const retain = (error: unknown): RuntimeAuthenticationError => {
      const failure = error instanceof RuntimeAuthenticationError ? error : new RuntimeAuthenticationError('Pi OAuth credential rotation could not be confirmed');
      if (failure !== error) Object.defineProperty(failure, 'cause', { value: error });
      return terminalAuth ??= failure;
    };
    const guard = async (signal?: AbortSignal) => {
      if (terminalAuth) throw terminalAuth;
      try { await owner.guard(target, signal); }
      catch (error) { if (error instanceof RuntimeAuthenticationError) throw retain(error); throw error; }
      if (terminalAuth) throw terminalAuth;
    };
    const credentials: PiCredentialStore = {
      async read(provider, options) {
        if (provider !== 'openai') return undefined;
        for (;;) {
          await guard(options?.signal);
          let value: Credential | undefined, ref: string | undefined, failure: unknown;
          try { value = await owner.raw(); ref = credentialRef(value); } catch (error) { failure = error; }
          options?.signal?.throwIfAborted();
          if (mutations.get(owner.context.authContextRef)?.size) continue;
          try { owner.check(target, ref); }
          catch (error) { throw retain(failure ?? error); }
          options?.signal?.throwIfAborted(); return value;
        }
      },
      async list(options) { return await credentials.read('openai', options) ? [{ providerId: 'openai', type: 'oauth' }] : []; },
      async delete() { throw new RuntimeAuthenticationError('An execution lease cannot delete Pi credentials'); },
      modify(provider, fn, options) {
        if (provider !== 'openai' || refreshContexts.getStore() !== capability) return Promise.reject(new RuntimeAuthenticationError('Only official auth resolution may rotate Pi OAuth'));
        options?.signal?.throwIfAborted();
        const operationId = randomUUID(); let entered = false, startingRef: string | undefined;
        const marker = { kind: 'refresh' as const, operationId, authContextRef: owner.context.authContextRef,
          connectionRef: target.connectionRef, authGeneration: target.authGeneration };
        let committedCandidate: OwnerRecord | undefined;
        const mutation = Promise.resolve().then(async () => {
          // Omit the native cancellation race. getAuth may cancel, but this promise owns actual saving/finalization.
          const value = await owner.native.modify(provider, async current => {
            options?.signal?.throwIfAborted(); owner.assertContext();
            // The prior native lock may already be released while its owner finalization is still pending.
            // Wait only that exact earlier operation, never this callback or a queued lock waiter.
            const previous = owner.readRecord()?.pendingRefresh;
            if (previous && previous.operationId !== operationId) {
              const registered = mutations.get(owner.context.authContextRef)?.get(previous.operationId);
              if (registered) await registered.catch(() => {});
            }
            options?.signal?.throwIfAborted();
            const ref = credentialRef(current);
            owner.locked(() => {
              const record = owner.readRecord();
              if (!owner.matches(record, target) || record.pendingRefresh || record.pendingLogin || record.credentialRef !== ref) {
                if (owner.matches(record, target) && !record.pendingRefresh && !record.pendingLogin) owner.fence(record);
                throw new RuntimeAuthenticationError('Pi OAuth changed before the native refresh lock');
              }
              entered = true; startingRef = ref;
              owner.write({ ...record, pendingRefresh: marker });
            });
            return fn(current);
          });
          const ref = credentialRef(value);
          // Preserve the ticket until the actual saved OAuth is verified outside the metadata lock.
          const actual = credentialRef(await owner.raw());
          if (actual !== ref) throw new RuntimeAuthenticationError('Pi saved OAuth credential could not be verified');
          owner.assertContext();
          owner.locked(() => {
            const record = owner.readRecord();
            if (!owner.matches(record, target) || record.credentialRef !== startingRef
              || record.pendingLogin || JSON.stringify(record.pendingRefresh) !== JSON.stringify(marker)) {
              throw new RuntimeAuthenticationError('The Pi refresh ticket is no longer admitted');
            }
            const { pendingRefresh: _pending, ...rest } = record;
            committedCandidate = RecordSchema.parse({ ...rest, credentialRef: ref });
            owner.write(committedCandidate);
          });
          return value;
        }).catch(error => {
          if (!entered && options?.signal?.aborted) throw options.signal.reason ?? error;
          const failure = retain(error);
          if (entered) {
            try {
              owner.locked(() => { const record = owner.readRecord();
                if (!owner.matches(record, target)) return;
                const ownsPending = record.credentialRef === startingRef
                  && !record.pendingLogin && JSON.stringify(record.pendingRefresh) === JSON.stringify(marker);
                // rename may publish the exact candidate before directory fsync reports failure.
                const ownsCommitted = committedCandidate && !record.pendingRefresh && !record.pendingLogin
                  && JSON.stringify(record) === JSON.stringify(committedCandidate);
                if (ownsPending) {
                  // The awaited actual native mutation has settled. Only this
                  // full ticket can release its own exclusion, never a successor.
                  const { pendingRefresh: _pending, ...rest } = record;
                  owner.write({ ...rest, authGeneration: record.authGeneration + 1, localState: 'unknown' });
                } else if (ownsCommitted) owner.fence(record);
              });
            } catch (fencingFailure) { Object.defineProperty(failure, 'fencingFailure', { value: fencingFailure }); }
            mutationFailure ??= failure;
          }
          throw failure;
        });
        let pending = mutations.get(owner.context.authContextRef);
        if (!pending) { pending = new Map(); mutations.set(owner.context.authContextRef, pending); }
        pending.set(operationId, mutation);
        void mutation.finally(() => { pending!.delete(operationId); if (!pending!.size) mutations.delete(owner.context.authContextRef); }).catch(() => {});
        return mutation;
      },
    };
    return Object.freeze({ credentials, guard,
      async drain() {
        await owner.drain();
        if (mutationFailure && !failureDelivered) { failureDelivered = true; throw mutationFailure; }
      },
      async resolveAuth<T>(resolveAuth: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await guard(signal);
        let value: T;
        try { value = await refreshContexts.run(capability, resolveAuth); }
        catch (error) { await guard(signal); throw error; }
        await guard(signal); return value;
      } });
  }
}
