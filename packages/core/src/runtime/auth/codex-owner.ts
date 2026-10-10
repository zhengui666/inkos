import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CodexClient } from '../../codex/app-server.js';
import { withBookLockGuard } from '../../state/book-lock-guard.js';
import type { ModelConnectionAdmission, RuntimeSelection } from '../contracts.js';

const OWNER_FILE = 'inkos-connection.json';
const DigestRefSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentityRefsSchema = z.object({ email: DigestRefSchema.nullable(), accountId: DigestRefSchema.nullable() }).strict();
type IdentityRefs = z.infer<typeof IdentityRefsSchema>;
// Legacy v1 records used one prefixed hash; retain their version, generation and ref.
const IdentityRefSchema = z.union([z.string().regex(/^(email|account):[a-f0-9]{64}$/), IdentityRefsSchema]).nullable();
const RecordSchema = z.object({
  schemaVersion: z.literal(1), harnessId: z.literal('codex'),
  authContextRef: z.string().min(1), connectionRef: z.string().min(1),
  authGeneration: z.number().int().positive().safe(),
  localState: z.enum(['ready', 'disconnected', 'transitioning', 'unknown']),
  operationId: z.string().nullable(), identityRef: IdentityRefSchema,
}).strict().refine(record => (record.localState === 'transitioning') === (record.operationId !== null), 'Invalid authentication operation state');
export type CodexConnectionRecord = z.infer<typeof RecordSchema>;
/** Durable owner state, excluding account identity evidence. Captured under the owner mutex. */
export type CodexConnectionStamp = Readonly<Pick<CodexConnectionRecord,
  'authContextRef' | 'connectionRef' | 'authGeneration' | 'localState' | 'operationId'>>;
function stamp(record: CodexConnectionRecord): CodexConnectionStamp {
  const { authContextRef, connectionRef, authGeneration, localState, operationId } = record;
  return Object.freeze({ authContextRef, connectionRef, authGeneration, localState, operationId });
}
export type CodexAuthOperation = Readonly<{ operationId: string; authGeneration: number }>;
export type CodexAuthenticationTarget = Pick<RuntimeSelection, 'harnessId' | 'authContextRef' | 'connectionRef' | 'authGeneration'>;
export interface CodexAccountObservation {
  readonly type: 'chatgpt';
  readonly planType: string | null;
  readonly identityPresent: boolean;
}
export interface CodexOwnerObservation<T> {
  readonly harnessId: 'codex';
  readonly authContextRef: string;
  readonly owner: Readonly<Omit<CodexConnectionRecord, 'identityRef' | 'schemaVersion'>> | null;
  readonly account: Readonly<CodexAccountObservation> | null;
  readonly value: T | null;
  readonly ready: boolean;
  readonly readyReasons: readonly string[];
}

export class RuntimeAuthenticationError extends Error {
  readonly code = 'RUNTIME_AUTH_REVOKED';
  constructor(message = 'The Codex ChatGPT connection is no longer admitted') { super(message); }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** This is a trusted client path, never a browser/admission-supplied reference. */
export function codexAuthenticationContext(client: Pick<CodexClient, 'codexHome'>): { home: string; harnessId: 'codex'; authContextRef: string } {
  const home = realpathSync(client.codexHome);
  return Object.freeze({ home, harnessId: 'codex', authContextRef: `codex-context-${digest(home)}` });
}

function identities(value: z.infer<typeof IdentityRefSchema>): IdentityRefs {
  if (value === null) return { email: null, accountId: null };
  if (typeof value !== 'string') return value;
  if (value.startsWith('email:')) return { email: value.slice(6), accountId: null };
  if (value.startsWith('account:')) return { email: null, accountId: value.slice(8) };
  throw new RuntimeAuthenticationError('Cannot compare the legacy Codex account identity');
}
function accountEvidence(value: unknown): { authenticated: boolean; identityRef: IdentityRefs } {
  const response = object(value), account = object(response.account), routing = object(response.workspaceRouting);
  // requiresOpenaiAuth=false never exempts this check, including loopback providers.
  const authenticated = account.type === 'chatgpt';
  return { authenticated, identityRef: {
    email: authenticated && typeof account.email === 'string' && account.email ? digest(`email:${account.email}`) : null,
    accountId: authenticated && typeof routing.chatgptAccountId === 'string' && routing.chatgptAccountId ? digest(`account:${routing.chatgptAccountId}`) : null,
  } };
}
function changedIdentity(before: z.infer<typeof IdentityRefSchema>, after: z.infer<typeof IdentityRefSchema>): boolean {
  const previous = identities(before), next = identities(after);
  const keys = ['email', 'accountId'] as const;
  const comparable = keys.filter(key => previous[key] !== null && next[key] !== null);
  if (comparable.some(key => previous[key] !== next[key])) return true;
  // Two known but disjoint identity kinds cannot prove continuity. All-null account
  // metadata remains valid; learning an ID alongside the same email remains valid.
  return comparable.length === 0 && keys.some(key => previous[key] !== null) && keys.some(key => next[key] !== null);
}
const hasIdentity = (value: z.infer<typeof IdentityRefSchema>) => Object.values(identities(value)).some(identity => identity !== null);

/**
 * Shared non-secret application revocation record. This is not a provider token
 * epoch and does not detect unobserved external logout/relogin between probes.
 * No credentials are opened. Every network operation runs outside the mutex.
 */
export class CodexAuthenticationOwner {
  readonly context: Readonly<ReturnType<typeof codexAuthenticationContext>>;
  private readonly path: string;
  constructor(client: Pick<CodexClient, 'codexHome'>) {
    this.context = codexAuthenticationContext(client);
    this.path = join(this.context.home, OWNER_FILE);
  }
  private locked<T>(action: () => T): T { return withBookLockGuard(this.path, action); }
  private read(): CodexConnectionRecord | undefined {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new RuntimeAuthenticationError('Invalid Codex connection record');
      const record = RecordSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (record.authContextRef !== this.context.authContextRef) throw new RuntimeAuthenticationError('Codex connection record belongs to another context');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new RuntimeAuthenticationError('Cannot read the Codex connection record');
    }
  }
  private initial(): CodexConnectionRecord {
    return { schemaVersion: 1, harnessId: 'codex', authContextRef: this.context.authContextRef,
      connectionRef: `codex-connection-${randomUUID()}`, authGeneration: 1,
      localState: 'disconnected', operationId: null, identityRef: null };
  }
  private write(record: CodexConnectionRecord): CodexConnectionRecord {
    record = RecordSchema.parse(record);
    const temporary = join(this.context.home, `inkos-connection.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') {
        const directory = openSync(this.context.home, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      return record;
    } finally { rmSync(temporary, { force: true }); }
  }
  private bump(record: CodexConnectionRecord, patch: Partial<CodexConnectionRecord>): CodexConnectionRecord {
    return this.write({ ...record, ...patch, authGeneration: record.authGeneration + 1 });
  }
  /** A newly available identity improves later comparisons without revoking this epoch. */
  private learnIdentity(record: CodexConnectionRecord, identityRef: IdentityRefs): CodexConnectionRecord {
    const previous = identities(record.identityRef);
    const merged = { email: identityRef.email ?? previous.email, accountId: identityRef.accountId ?? previous.accountId };
    if (merged.email !== previous.email || merged.accountId !== previous.accountId) return this.write({ ...record, identityRef: merged });
    return record;
  }
  snapshot(): CodexConnectionRecord | undefined { return this.locked(() => this.read()); }
  private matches(record: CodexConnectionRecord | undefined, target: CodexAuthenticationTarget): boolean {
    return !!record && record.localState === 'ready' && record.harnessId === target.harnessId
      && record.authContextRef === target.authContextRef && record.connectionRef === target.connectionRef
      && record.authGeneration === target.authGeneration;
  }
  private admission(record: CodexConnectionRecord): ModelConnectionAdmission {
    return { harnessId: 'codex', authContextRef: record.authContextRef,
      connection: { provider: 'chatgpt', authMethod: 'oauth', connectionRef: record.connectionRef },
      authGeneration: record.authGeneration, ready: record.localState === 'ready',
      readyReasons: record.localState === 'ready' ? [] : [record.localState] };
  }

  /** Explicit execution admission/revalidation. An in-progress operation stays blocked. */
  async admit(client: CodexClient, signal?: AbortSignal, assertTrustedContext?: () => void): Promise<ModelConnectionAdmission> {
    signal?.throwIfAborted();
    assertTrustedContext?.();
    this.assertContext(client);
    const before = this.snapshot();
    let evidence: ReturnType<typeof accountEvidence>;
    try { evidence = accountEvidence(await client.request('account/read', { refreshToken: false }, { signal })); }
    catch { signal?.throwIfAborted(); throw new RuntimeAuthenticationError('Codex authentication could not be admitted'); }
    signal?.throwIfAborted();
    this.assertContext(client);
    assertTrustedContext?.();
    if (before?.localState === 'transitioning') throw new RuntimeAuthenticationError('A Codex authentication operation is still pending; reconcile it without replaying login');
    const record = this.locked(() => {
      const current = this.read();
      if (current?.authGeneration !== before?.authGeneration || current?.operationId !== before?.operationId) throw new RuntimeAuthenticationError();
      const value = current ?? this.initial();
      const identityChanged = changedIdentity(value.identityRef, evidence.identityRef);
      if (!evidence.authenticated) return current?.localState === 'disconnected' ? current
        : current ? this.bump(value, { localState: 'disconnected', operationId: null }) : this.write(value);
      if (identityChanged) return this.bump(value, { localState: 'ready', operationId: null,
        identityRef: evidence.identityRef });
      if (value.localState === 'ready') return this.learnIdentity(value, evidence.identityRef);
      // unknown is reconciled only by a fresh execution admission, never by retrying OAuth.
      return this.write({ ...value, localState: 'ready', operationId: null, identityRef: hasIdentity(evidence.identityRef) ? evidence.identityRef : value.identityRef });
    });
    if (record.localState !== 'ready') throw new RuntimeAuthenticationError('Sign in with ChatGPT before starting a text task');
    return this.admission(record);
  }

  private assertContext(client: Pick<CodexClient, 'codexHome'>): void {
    let actual: ReturnType<typeof codexAuthenticationContext>;
    try { actual = codexAuthenticationContext(client); }
    catch { throw new RuntimeAuthenticationError('Cannot resolve the trusted Codex context'); }
    if (actual.authContextRef !== this.context.authContextRef) {
      this.disconnect();
      throw new RuntimeAuthenticationError('Codex client belongs to a different authentication context');
    }
  }
  /** A passive account GET never creates/binds a connection or restores ready. */
  observe(client: CodexClient, value: unknown): void {
    this.assertContext(client);
    if (!this.read()) return;
    const evidence = accountEvidence(value);
    this.locked(() => {
      const current = this.read();
      if (current?.localState === 'ready' && (!evidence.authenticated || changedIdentity(current.identityRef, evidence.identityRef))) {
        this.bump(current, { localState: 'disconnected', operationId: null,
          ...(hasIdentity(evidence.identityRef) ? { identityRef: evidence.identityRef } : {}) });
      } else if (current?.localState === 'ready') this.learnIdentity(current, evidence.identityRef);
    });
  }
  /** A trusted probe envelope is output evidence, never an authority accepted from HTTP. */
  async probe<T>(client: CodexClient, inspect: () => Promise<T>, signal?: AbortSignal): Promise<CodexOwnerObservation<T>> {
    signal?.throwIfAborted();
    this.assertContext(client);
    const before = this.snapshot();
    const unknown = (reason: string): CodexOwnerObservation<T> => Object.freeze({
      harnessId: 'codex', authContextRef: this.context.authContextRef,
      owner: null, account: null, value: null, ready: false, readyReasons: Object.freeze([reason]),
    });
    try {
      const first = accountEvidence(await client.request('account/read', { refreshToken: false }, { signal }));
      const value = first.authenticated ? await inspect() : null;
      const raw = await client.request('account/read', { refreshToken: false }, { signal });
      const last = accountEvidence(raw);
      signal?.throwIfAborted(); this.assertContext(client);
      return this.locked(() => {
        const current = this.read();
        if (current?.authGeneration !== before?.authGeneration || current?.operationId !== before?.operationId
          || current?.connectionRef !== before?.connectionRef || current?.localState !== before?.localState) return unknown('owner-changed-during-probe');
        if (current?.localState === 'ready' && (!first.authenticated || !last.authenticated
          || changedIdentity(first.identityRef, last.identityRef) || changedIdentity(current.identityRef, first.identityRef)
          || changedIdentity(current.identityRef, last.identityRef))) {
          const knownIdentity = hasIdentity(last.identityRef) ? last.identityRef : first.identityRef;
          this.bump(current, { localState: 'disconnected', operationId: null,
            ...(hasIdentity(knownIdentity) ? { identityRef: knownIdentity } : {}) });
          return unknown('account-changed-during-probe');
        }
        if (!first.authenticated || !last.authenticated || changedIdentity(first.identityRef, last.identityRef)) return unknown('chatgpt-account-unverified');
        if (current && current.localState !== 'ready') return unknown(`owner-${current.localState}`);
        if (current) this.learnIdentity(current, last.identityRef);
        const account = object(object(raw).account);
        const owner = current ? Object.freeze({ harnessId: current.harnessId, authContextRef: current.authContextRef,
          connectionRef: current.connectionRef, authGeneration: current.authGeneration,
          localState: current.localState, operationId: current.operationId }) : null;
        return Object.freeze({ harnessId: 'codex', authContextRef: this.context.authContextRef, owner,
          account: Object.freeze({ type: 'chatgpt', planType: typeof account.planType === 'string' ? account.planType : null,
            identityPresent: hasIdentity(last.identityRef) }), value, ready: true, readyReasons: Object.freeze([]) });
      });
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw error;
      return unknown(error instanceof RuntimeAuthenticationError ? 'authentication-context-unverified' : 'probe-failed');
    }
  }
  /** Read/version -> live account/read -> unchanged read/version, with no network under lock. */
  async guard(target: CodexAuthenticationTarget, client: CodexClient, signal?: AbortSignal, assertTrustedContext?: () => void): Promise<void> {
    signal?.throwIfAborted();
    assertTrustedContext?.();
    this.assertContext(client);
    if (!this.matches(this.snapshot(), target)) throw new RuntimeAuthenticationError();
    let evidence: ReturnType<typeof accountEvidence>;
    try { evidence = accountEvidence(await client.request('account/read', { refreshToken: false }, { signal })); }
    catch (error) { signal?.throwIfAborted(); throw new RuntimeAuthenticationError('Codex authentication could not be revalidated'); }
    signal?.throwIfAborted();
    this.assertContext(client);
    assertTrustedContext?.();
    this.locked(() => {
      const current = this.read();
      if (!this.matches(current, target)) throw new RuntimeAuthenticationError();
      const identityChanged = changedIdentity(current!.identityRef, evidence.identityRef);
      if (!evidence.authenticated || identityChanged) {
        this.bump(current!, { localState: 'disconnected', operationId: null,
          ...(identityChanged ? { identityRef: evidence.identityRef } : {}) });
        throw new RuntimeAuthenticationError();
      }
      this.learnIdentity(current!, evidence.identityRef);
    });
  }

  begin(replaceConnection = false, onWritten?: (state: CodexConnectionStamp) => void): CodexAuthOperation {
    return this.locked(() => {
      const current = this.read() ?? this.initial();
      const next = this.bump(current, { localState: 'transitioning', operationId: randomUUID(),
        ...(replaceConnection ? { identityRef: null } : {}) });
      onWritten?.(stamp(next));
      return Object.freeze({ operationId: next.operationId!, authGeneration: next.authGeneration });
    });
  }
  complete(operation: CodexAuthOperation, state: 'disconnected' | 'unknown', onWritten?: (state: CodexConnectionStamp) => void): boolean {
    return this.locked(() => {
      const current = this.read();
      if (!current || current.localState !== 'transitioning' || !operation.operationId
        || current.operationId !== operation.operationId || current.authGeneration !== operation.authGeneration) return false;
      const next = this.write({ ...current, localState: state, operationId: null });
      onWritten?.(stamp(next)); return true;
    });
  }
  async completeLogin(operation: CodexAuthOperation, client: CodexClient, onWritten?: (state: CodexConnectionStamp) => void): Promise<boolean> {
    this.assertContext(client);
    const before = this.snapshot();
    if (!before || before.localState !== 'transitioning' || !operation.operationId
      || before.operationId !== operation.operationId || before.authGeneration !== operation.authGeneration) return false;
    let evidence: ReturnType<typeof accountEvidence>;
    try { evidence = accountEvidence(await client.request('account/read', { refreshToken: false })); }
    catch { return this.complete(operation, 'unknown', onWritten); }
    this.assertContext(client);
    return this.locked(() => {
      const current = this.read();
      if (!current || current.localState !== 'transitioning' || current.operationId !== operation.operationId
        || current.authGeneration !== operation.authGeneration) return false;
      const next = this.write({ ...current, localState: evidence.authenticated ? 'ready' : 'disconnected',
        operationId: null, identityRef: evidence.identityRef });
      onWritten?.(stamp(next)); return true;
    });
  }
  disconnect(): void {
    this.locked(() => { this.bump(this.read() ?? this.initial(), { localState: 'disconnected', operationId: null }); });
  }
}
