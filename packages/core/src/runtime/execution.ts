import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { createCodexClient } from '../codex/client.js';
import { resolveCodexHome } from '../codex/app-server.js';
import type { CodexClient } from '../codex/app-server.js';
import type { CodexSettings } from '../codex/types.js';
import { AgentSettingsSchema, type AgentSettings, type HarnessDescriptor, type ModelConnectionAdmission } from './contracts.js';
import { AgentSettingsConflictError, readAgentSettings, updateAgentSettings } from './settings.js';
import { resolveRuntimeSelection } from './selection.js';
import { CodexAuthenticationOwner, RuntimeAuthenticationError, type CodexOwnerObservation } from './auth/codex-owner.js';
import { CodexRuntimeAdapter, codexServiceTierRequestValue, type CodexNativeDefaultsEvidence } from './adapters/codex/adapter.js';
import { currentCodexRun, currentRuntimeRun, runWithCodexContext, runWithRuntimeContext, type CodexRunContext, type PiRunContext } from './run-context.js';
import { PiRuntimeAdapter } from './registry.js';
import { appendRunDispatch, appendRunObservation, type RunHistoryBinding } from './run-history.js';
import type { AgentModelCallTrace } from '../llm/agent-trajectory.js';

export interface CodexExecutionOptions {
  signal?: AbortSignal;
  /** Legacy per-invocation overrides, validated once, never persisted or reapplied by workers. */
  settings?: CodexSettings;
  model?: string;
}

/** Queue entrypoint. Read the selected harness once; nested work inherits the frozen run. */
export async function withRuntimeExecution<T>(projectRoot: string, task: () => Promise<T>, options: CodexExecutionOptions = {}): Promise<T> {
  const current = currentRuntimeRun();
  if (current) {
    if (realpathSync(projectRoot) !== realpathSync(current.projectRoot)) throw new RuntimeAuthenticationError('Nested execution belongs to another project context');
    await guardRuntimeExecution(options.signal); return task();
  }
  const settings = await readAgentSettings(projectRoot);
  if (settings.selectedHarnessId === 'codex') return withCodexExecution(projectRoot, task, options);
  if (options.model || options.settings) throw new RuntimeAuthenticationError('Codex invocation overrides cannot route Pi');
  let owner: import('./auth/pi-owner.js').PiAuthenticationOwner;
  try { const { PiAuthenticationOwner } = await import('./auth/pi-owner.js'); owner = await PiAuthenticationOwner.create(projectRoot); }
  catch (error) {
    if (error instanceof RuntimeAuthenticationError) throw error;
    throw Object.assign(new Error('Pi native runtime is not available in this deployment'), { code: 'RUNTIME_HARNESS_NOT_CONNECTED' });
  }
  const { createPiRuntimeContext } = await import('./adapters/pi/runtime-context.js');
  const connection = await owner.admit(options.signal);
  const target = { harnessId: 'pi' as const, authContextRef: connection.authContextRef,
    connectionRef: connection.connection.connectionRef, authGeneration: connection.authGeneration };
  const lease = owner.lease(target);
  let historyFailure: Error | undefined;
  let authenticationFailure: RuntimeAuthenticationError | undefined;
  const checkHistory = () => { if (historyFailure) throw historyFailure; if (authenticationFailure) throw authenticationFailure; };
  const guard = async (signal?: AbortSignal) => {
    checkHistory(); try { await lease.guard(signal); } catch (error) {
      if (error instanceof RuntimeAuthenticationError) authenticationFailure ??= error;
      throw historyFailure ?? authenticationFailure ?? error;
    } checkHistory();
  };
  try {
    await guard(options.signal);
    const runtime = await createPiRuntimeContext({ ...owner.scope, speed: settings.harnessPreferences.pi.speed,
      credentials: lease.credentials, resolveAuth: async (resolveAuth, signal) => {
        await guard(signal);
        try { const result = await lease.resolveAuth(resolveAuth, signal); await guard(signal); return result; }
        catch (error) { if (error instanceof RuntimeAuthenticationError) authenticationFailure ??= error; throw historyFailure ?? authenticationFailure ?? error; }
      } });
    await guard(options.signal);
    const harness = await new PiRuntimeAdapter(runtime).describe();
    await guard(options.signal);
    let desired = settings;
    for (let attempt = 0; desired.modelConnectionRef === null; attempt++) {
      if (attempt >= 8) throw new Error('Agent configuration kept changing during connection binding');
      await guard(options.signal);
      try { desired = await updateAgentSettings(projectRoot, { modelConnectionRef: target.connectionRef }, { expectedRevision: desired.revision }); }
      catch (error) {
        if ((error as { code?: string }).code !== 'AGENT_SETTINGS_REVISION_CONFLICT') throw error;
        desired = await readAgentSettings(projectRoot);
        if (desired.selectedHarnessId !== 'pi') throw new RuntimeAuthenticationError('The selected harness changed before admission');
      }
    }
    const saved = Object.freeze({ ...desired.harnessPreferences.pi });
    const selection = resolveRuntimeSelection({ settings: desired, harness, authContext: owner.context, connection });
    const context: PiRunContext = { harnessId: 'pi', projectRoot: resolve(projectRoot), saved, selection, runtime, lease, guard,
      onHistoryFailure(failure) { historyFailure ??= failure; } };
    await guard(options.signal);
    return await runWithRuntimeContext(context, task);
  } finally { await lease.drain(); }
}

export async function guardRuntimeExecution(signal?: AbortSignal): Promise<void> {
  const context = currentRuntimeRun();
  if (!context) throw new RuntimeAuthenticationError('No admitted runtime context');
  if (context.harnessId === 'pi') await context.guard(signal); else await context.guard(undefined, signal);
}

/** Local installation/OAuth/catalog evidence only; never account entitlement or execution evidence. */
export interface PiRuntimeObservation {
  readonly harnessId: 'pi';
  readonly installation: 'installed' | 'missing' | 'unknown';
  readonly authContextRef: string | null;
  readonly authentication: 'missing' | 'oauth-present' | 'unknown';
  readonly owner: Readonly<ModelConnectionAdmission> | null;
  readonly descriptor: HarnessDescriptor | null;
  readonly catalogOwnership: Readonly<{ harnessId: 'pi'; authContextRef: string;
    authGeneration: number | null; adapterVersion: string }> | null;
  readonly ready: boolean;
  readonly readyReasons: readonly string[];
}

/** Passive Pi GET/preload never admits/binds a connection or resolves OAuth. */
export async function observePiRuntime(projectRoot: string, signal?: AbortSignal): Promise<PiRuntimeObservation> {
  signal?.throwIfAborted();
  let installation: PiRuntimeObservation['installation'] = 'unknown';
  let authContextRef: string | null = null;
  let authentication: PiRuntimeObservation['authentication'] = 'unknown';
  let owner: PiRuntimeObservation['owner'] = null;
  let descriptor: HarnessDescriptor | null = null;
  try {
    try {
      if (!findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url)) {
        installation = 'missing'; throw new Error('Pi SDK entry is not installed');
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') installation = 'missing';
      throw error;
    }
    const { loadPiNativeAuthStorage } = await import('./auth/pi-native-store-compat.js');
    await loadPiNativeAuthStorage(); signal?.throwIfAborted(); installation = 'installed';
    const { PiAuthenticationOwner } = await import('./auth/pi-owner.js');
    const trustedOwner = await PiAuthenticationOwner.create(projectRoot);
    const observed = await trustedOwner.observeSnapshot(async () => {
      const { createPiRuntimeContext } = await import('./adapters/pi/runtime-context.js');
      return new PiRuntimeAdapter(await createPiRuntimeContext({ ...trustedOwner.scope, passiveObservation: true })).describe();
    }, signal);
    ({ authContextRef, authentication, owner, value: descriptor } = observed);
  } catch { signal?.throwIfAborted(); }
  signal?.throwIfAborted();
  const catalogOwnership = descriptor && authContextRef ? { harnessId: 'pi' as const, authContextRef,
    authGeneration: owner?.authGeneration ?? null, adapterVersion: descriptor.adapterVersion } : null;
  const ready = installation === 'installed' && authentication === 'oauth-present' && descriptor?.ready === true;
  const readyReasons = ready ? [] : [
    ...({ installed: [], missing: ['pi-sdk-missing'], unknown: ['pi-sdk-unverified'] }[installation]),
    ...(authentication !== 'oauth-present' ? [authentication === 'missing' ? 'pi-authentication-missing' : 'pi-authentication-unverified'] : []),
    ...(installation === 'installed' && authentication === 'oauth-present' && !descriptor?.ready ? ['pi-catalog-unverified'] : []),
  ];
  const snapshot: PiRuntimeObservation = { harnessId: 'pi', installation, authContextRef, authentication, owner,
    descriptor, catalogOwnership, ready, readyReasons };
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  }
  freeze(snapshot); return snapshot;
}

export interface CodexRuntimeObservation extends Omit<CodexOwnerObservation<never>, 'value'> {
  readonly descriptor: HarnessDescriptor | null;
  readonly catalogOwnership: Readonly<{ harnessId: 'codex'; adapterVersion: string; authContextRef: string;
    authGeneration: number | null; operationId: string | null }> | null;
  readonly nativeDefaultsEvidence: Readonly<CodexNativeDefaultsEvidence> | null;
}

/** Same real peer/account/context before and after catalog/config probes; no config binding. */
export async function observeCodexRuntime(client: CodexClient, signal?: AbortSignal): Promise<CodexRuntimeObservation> {
  const owner = new CodexAuthenticationOwner(client), adapter = new CodexRuntimeAdapter(client, signal);
  const { value, ...observed } = await owner.probe(client, () => adapter.describe(), signal);
  const descriptor = observed.ready ? value : null;
  return Object.freeze({ ...observed, descriptor,
    catalogOwnership: descriptor ? Object.freeze({ harnessId: 'codex', adapterVersion: descriptor.adapterVersion,
      authContextRef: observed.authContextRef, authGeneration: observed.owner?.authGeneration ?? null,
      operationId: observed.owner?.operationId ?? null }) : null,
    nativeDefaultsEvidence: descriptor ? adapter.nativeDefaultsEvidence : null });
}

function trustedProjectContext(projectRoot: string, client: CodexClient, configuredHome = resolveCodexHome(projectRoot)): () => void {
  // Expected context comes exclusively from trusted project/deployment resolution.
  // A peer may execute in an isolated cwd; neither cwd nor ref establishes authority.
  let expectedHome: string;
  try { expectedHome = realpathSync(configuredHome); }
  catch { throw new RuntimeAuthenticationError('Cannot resolve the project Codex context'); }
  const assertTrustedContext = () => {
    let configured: string, actual: string;
    try { configured = realpathSync(resolveCodexHome(projectRoot)); actual = realpathSync(client.codexHome); }
    catch { throw new RuntimeAuthenticationError('Cannot verify the project Codex context'); }
    if (configured !== expectedHome || actual !== expectedHome) throw new RuntimeAuthenticationError('The client does not belong to the current project Codex context');
  };
  assertTrustedContext();
  return assertTrustedContext;
}

/** Only the trusted peer supplies the connection ref. A browser supplies expectedRevision. */
export async function bindCodexModelConnection(projectRoot: string, client: CodexClient, options: {
  expectedRevision: number; signal?: AbortSignal;
}): Promise<AgentSettings> {
  const settings = await readAgentSettings(projectRoot);
  if (settings.revision !== options.expectedRevision) throw new AgentSettingsConflictError(options.expectedRevision, settings.revision);
  if (settings.selectedHarnessId !== 'codex') throw new RuntimeAuthenticationError('Binding requires the selected Codex harness');
  const assertTrustedContext = trustedProjectContext(projectRoot, client);
  const owner = new CodexAuthenticationOwner(client), admitted = await owner.admit(client, options.signal, assertTrustedContext);
  await owner.guard({ harnessId: 'codex', authContextRef: admitted.authContextRef,
    connectionRef: admitted.connection.connectionRef, authGeneration: admitted.authGeneration }, client, options.signal, assertTrustedContext);
  assertTrustedContext();
  return updateAgentSettings(projectRoot, { modelConnectionRef: admitted.connection.connectionRef }, { expectedRevision: options.expectedRevision });
}

/** Called inside the request/worker queue, before any model or host execution. */
export async function withCodexExecution<T>(projectRoot: string, task: () => Promise<T>, options: CodexExecutionOptions = {}): Promise<T> {
  const current = currentCodexRun();
  if (current) {
    if (resolve(projectRoot) !== current.projectRoot) throw new RuntimeAuthenticationError('Nested execution belongs to another project context');
    options.signal?.throwIfAborted();
    await current.guard(undefined, options.signal);
    return task();
  }
  options.signal?.throwIfAborted();
  let settings = await readAgentSettings(projectRoot);
  if (settings.selectedHarnessId !== 'codex') throw Object.assign(new Error('The selected Pi harness is not connected to this execution path'), { code: 'RUNTIME_HARNESS_NOT_CONNECTED' });
  const configuredHome = resolveCodexHome(projectRoot);
  const client = await createCodexClient(projectRoot);
  let leased = false;
  const peers = new Set<CodexClient>();
  try {
    const assertProjectContext = trustedProjectContext(projectRoot, client, configuredHome);
    const owner = new CodexAuthenticationOwner(client);
    const connection = await owner.admit(client, options.signal, assertProjectContext);
    const adapter = new CodexRuntimeAdapter(client, options.signal);
    const harness = await adapter.describe();
    // A verified existing login may bind for execution. Config GET/preload never calls this.
    for (let attempt = 0; settings.modelConnectionRef === null; attempt++) {
      if (attempt >= 8) throw new Error('Agent configuration kept changing during connection binding');
      assertProjectContext();
      try { settings = await updateAgentSettings(projectRoot, { modelConnectionRef: connection.connection.connectionRef }, { expectedRevision: settings.revision }); }
      catch (error) {
        if ((error as { code?: string }).code !== 'AGENT_SETTINGS_REVISION_CONFLICT') throw error;
        settings = await readAgentSettings(projectRoot);
        if (settings.selectedHarnessId !== 'codex') throw new RuntimeAuthenticationError('The selected harness changed before admission');
      }
    }
    if (settings.modelConnectionRef !== connection.connection.connectionRef) throw new RuntimeAuthenticationError('Saved model connection belongs to a different owner record');
    const desired = AgentSettingsSchema.parse(settings);
    const saved = Object.freeze({ ...desired.harnessPreferences.codex });
    desired.harnessPreferences.codex = adapter.canonicalPreferences({ ...saved,
      ...(options.settings ? { model: options.settings.model ?? null, effort: options.settings.reasoningEffort, speed: options.settings.serviceTier } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
    const selection = resolveRuntimeSelection({ settings: desired, harness,
      authContext: { harnessId: 'codex', authContextRef: owner.context.authContextRef }, connection });
    const assertTrustedContext = () => {
      // Deployment context is independently resolved again; it is never reconstructed from a ref.
      try { assertProjectContext(); }
      catch (error) { owner.disconnect(); throw error; }
    };
    let historyFailure: Error | undefined;
    const checkHistory = () => { if (historyFailure) throw historyFailure; };
    const context: CodexRunContext = {
      harnessId: 'codex', projectRoot: resolve(projectRoot), saved, selection, owner,
      onHistoryFailure(failure) { historyFailure ??= failure; },
      async takeClient() {
        checkHistory();
        if (!leased) { leased = true; peers.add(client); client.onClose(() => peers.delete(client)); return client; }
        let peer: CodexClient | undefined;
        try {
          peer = await createCodexClient(projectRoot);
          checkHistory();
          await owner.guard(selection, peer, options.signal);
          checkHistory();
          const leasedPeer = peer;
          peers.add(leasedPeer); leasedPeer.onClose(() => peers.delete(leasedPeer)); return leasedPeer;
        } catch (error) {
          try { await peer?.close(); } catch (cleanupError) { if (!historyFailure) throw cleanupError; }
          throw historyFailure ?? error;
        }
      },
      async guard(peer, signal) {
        checkHistory();
        assertTrustedContext();
        try {
          const active = peer ?? [...peers].find(peer => !peer.closed);
          if (active) await owner.guard(selection, active, signal, assertTrustedContext);
          else {
            const probe = await createCodexClient(projectRoot);
            try { await owner.guard(selection, probe, signal, assertTrustedContext); } finally { await probe.close(); }
          }
        } catch (error) { throw historyFailure ?? error; }
        // The successful recheck grants permission. Later failure does not recall an admitted operation.
        checkHistory();
      },
    };
    await context.guard(client, options.signal);
    return await runWithCodexContext(context, task);
  } finally {
    if (!leased) await client.close();
    else await Promise.all([...peers].filter(peer => !peer.closed).map(peer => peer.close()));
  }
}

export async function guardCodexExecution(signal?: AbortSignal): Promise<void> {
  const context = currentCodexRun();
  if (!context) throw new RuntimeAuthenticationError('No admitted runtime context');
  await context.guard(undefined, signal);
}

function admittedRun(): CodexRunContext {
  const runtime = currentCodexRun();
  if (!runtime) throw new RuntimeAuthenticationError('No admitted runtime context');
  return runtime;
}
function unrouted(parameters: Record<string, unknown>): void {
  for (const key of ['model', 'modelProvider', 'effort', 'serviceTier', 'serviceTierForTurn', 'config', 'collaborationMode']) {
    if (Object.hasOwn(parameters, key)) throw new Error('Runtime routing belongs to the frozen selection');
  }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const admittedThreads = new WeakMap<CodexRunContext, WeakMap<CodexClient, Set<string>>>();
export interface CodexThreadEffective {
  readonly scope: 'thread';
  readonly modelId?: string;
  readonly effort?: string | null;
  readonly serviceTier?: string | null;
}

export interface CodexCallHistory {
  readonly binding: RunHistoryBinding;
  readonly trace: AgentModelCallTrace;
}
function historyIdentity(history: CodexCallHistory) {
  if (history.trace.runId !== history.binding.coreRequestId) throw new Error('Model call belongs to another core request');
  return { schemaVersion: 1 as const, sessionId: history.binding.sessionId, coreRequestId: history.binding.coreRequestId,
    modelCallId: history.trace.modelCallId };
}
function historyCall(history: CodexCallHistory) {
  return { ...historyIdentity(history), agentRole: history.trace.agentRole,
    ...(history.trace.parentToolCallId ? { parentToolCallId: history.trace.parentToolCallId } : {}) };
}
/** A failed durable receipt is a host failure, never permission to replay an acknowledged RPC. */
export class RuntimeHistoryWriteError extends Error {
  readonly code = 'RUNTIME_HISTORY_WRITE_FAILED';
  constructor(cause: unknown) { super('Could not persist runtime history; the RPC outcome must not be retried', { cause }); }
}
function persistHistory(write: () => unknown): void {
  try { write(); } catch (error) {
    const failure = new RuntimeHistoryWriteError(error);
    currentRuntimeRun()?.onHistoryFailure?.(failure);
    throw failure;
  }
}

/** Guarded RPC boundary. General thread options cannot smuggle in routing overrides. */
export async function startCodexRuntimeThread(client: CodexClient, parameters: Record<string, unknown>, signal?: AbortSignal, history?: CodexCallHistory): Promise<{
  threadId: string; effective: Readonly<CodexThreadEffective>;
}> {
  const runtime = admittedRun(), selection = runtime.selection;
  unrouted(parameters);
  await runtime.guard(client, signal);
  const wire = { model: selection.modelId,
    ...(selection.serviceTier !== null ? { serviceTier: selection.serviceTier === 'default' ? null : selection.serviceTier } : {}),
  };
  if (history) persistHistory(() => appendRunDispatch(history.binding, { ...historyCall(history), kind: 'dispatch',
    operation: 'codex-thread-start', wire }));
  const response = object(await client.request('thread/start', { ...parameters, ...wire }, { signal }));
  const threadId = object(response.thread).id;
  if (typeof threadId !== 'string' || !threadId) throw new Error('Codex did not acknowledge a thread identifier');
  const effective: CodexThreadEffective = Object.freeze({ scope: 'thread',
    ...(typeof response.model === 'string' ? { modelId: response.model } : {}),
    ...(typeof response.reasoningEffort === 'string' || response.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
    ...(typeof response.serviceTier === 'string' || response.serviceTier === null ? { serviceTier: response.serviceTier } : {}),
  });
  if (history) persistHistory(() => {
    const { scope: _scope, ...observed } = effective;
    appendRunObservation(history.binding, { ...historyIdentity(history), kind: 'observation',
      source: 'codex-thread-start-ack', scope: 'thread', threadId, effective: observed });
  });
  if (effective.modelId !== undefined && effective.modelId !== selection.modelId) throw new Error('Codex acknowledged an incompatible model');
  if (selection.serviceTier !== null && selection.serviceTier !== 'default' && typeof effective.serviceTier === 'string'
    && codexServiceTierRequestValue(effective.serviceTier) !== codexServiceTierRequestValue(selection.serviceTier)) throw new Error('Codex acknowledged an incompatible service tier');
  let peers = admittedThreads.get(runtime);
  if (!peers) { peers = new WeakMap(); admittedThreads.set(runtime, peers); }
  const threads = peers.get(client) ?? new Set<string>();
  threads.add(threadId); peers.set(client, threads);
  return { threadId, effective };
}

/** turn/start ACK contains only the turn; later overrides remain requested. */
export async function startCodexRuntimeTurn(client: CodexClient, parameters: Record<string, unknown>, signal?: AbortSignal, history?: CodexCallHistory): Promise<{
  turnId: string;
  requested: Readonly<{ scope: 'turn'; modelId: string; effort: string | null; serviceTier: string | null }>;
}> {
  const runtime = admittedRun(), selection = runtime.selection;
  unrouted(parameters);
  if (typeof parameters.threadId !== 'string' || !admittedThreads.get(runtime)?.get(client)?.has(parameters.threadId)) {
    throw new RuntimeAuthenticationError('The thread was not admitted by this run and peer');
  }
  await runtime.guard(client, signal);
  const wire = { model: selection.modelId,
    ...(selection.effort !== null ? { effort: selection.effort } : {}),
    ...(selection.serviceTier !== null ? { serviceTierForTurn: codexServiceTierRequestValue(selection.serviceTier) } : {}),
  };
  if (history) persistHistory(() => appendRunDispatch(history.binding, { ...historyCall(history), kind: 'dispatch',
    operation: 'codex-turn-start', threadId: parameters.threadId as string, wire }));
  const response = object(await client.request('turn/start', { ...parameters, ...wire }, { signal }));
  const turnId = object(response.turn).id;
  if (typeof turnId !== 'string' || !turnId) throw new Error('Codex did not acknowledge a turn identifier');
  // 0.159.2 TurnStartResponse acknowledges identity only, with no effective routing fields.
  if (history) persistHistory(() => appendRunObservation(history.binding, { ...historyIdentity(history), kind: 'observation',
    source: 'codex-turn-start-ack', scope: 'turn', threadId: parameters.threadId as string, turnId, effective: {} }));
  return { turnId, requested: Object.freeze({ scope: 'turn', modelId: selection.modelId,
    effort: selection.effort, serviceTier: selection.serviceTier }) };
}

/** Revocation prevents new permits; an already-admitted operation cannot be rolled back here. */
export async function dispatchCodexHostEffect<T>(client: CodexClient, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await admittedRun().guard(client, signal);
  return operation();
}
