import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createCodexClient } from '../codex/client.js';
import { resolveCodexHome } from '../codex/app-server.js';
import type { CodexClient } from '../codex/app-server.js';
import type { CodexSettings } from '../codex/types.js';
import { AgentSettingsSchema, type AgentSettings, type HarnessDescriptor } from './contracts.js';
import { AgentSettingsConflictError, readAgentSettings, updateAgentSettings } from './settings.js';
import { resolveRuntimeSelection } from './selection.js';
import { CodexAuthenticationOwner, RuntimeAuthenticationError, type CodexOwnerObservation } from './auth/codex-owner.js';
import { CodexRuntimeAdapter, type CodexNativeDefaultsEvidence } from './adapters/codex/adapter.js';
import { currentCodexRun, runWithCodexContext, type CodexRunContext } from './run-context.js';

export interface CodexExecutionOptions {
  signal?: AbortSignal;
  /** Legacy per-invocation overrides, validated once, never persisted or reapplied by workers. */
  settings?: CodexSettings;
  model?: string;
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
    const context: CodexRunContext = {
      projectRoot: resolve(projectRoot), saved, selection, owner,
      async takeClient() {
        if (!leased) { leased = true; peers.add(client); client.onClose(() => peers.delete(client)); return client; }
        const peer = await createCodexClient(projectRoot);
        try { await owner.guard(selection, peer, options.signal); peers.add(peer); peer.onClose(() => peers.delete(peer)); return peer; }
        catch (error) { await peer.close(); throw error; }
      },
      async guard(peer, signal) {
        assertTrustedContext();
        if (peer) { await owner.guard(selection, peer, signal, assertTrustedContext); return; }
        const active = [...peers].find(peer => !peer.closed);
        if (active) { await owner.guard(selection, active, signal, assertTrustedContext); return; }
        const probe = await createCodexClient(projectRoot);
        try { await owner.guard(selection, probe, signal, assertTrustedContext); } finally { await probe.close(); }
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

/** Guarded RPC boundary. General thread options cannot smuggle in routing overrides. */
export async function startCodexRuntimeThread(client: CodexClient, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<{
  threadId: string; effective: Readonly<CodexThreadEffective>;
}> {
  const runtime = admittedRun(), selection = runtime.selection;
  unrouted(parameters);
  await runtime.guard(client, signal);
  const response = object(await client.request('thread/start', { ...parameters, model: selection.modelId,
    ...(selection.serviceTier !== null ? { serviceTier: selection.serviceTier === 'default' ? null : selection.serviceTier } : {}),
  }, { signal }));
  const threadId = object(response.thread).id;
  if (typeof threadId !== 'string' || !threadId) throw new Error('Codex did not acknowledge a thread identifier');
  const effective: CodexThreadEffective = Object.freeze({ scope: 'thread',
    ...(typeof response.model === 'string' ? { modelId: response.model } : {}),
    ...(typeof response.reasoningEffort === 'string' || response.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
    ...(typeof response.serviceTier === 'string' || response.serviceTier === null ? { serviceTier: response.serviceTier } : {}),
  });
  if (effective.modelId !== undefined && effective.modelId !== selection.modelId) throw new Error('Codex acknowledged an incompatible model');
  if (selection.serviceTier !== null && selection.serviceTier !== 'default' && effective.serviceTier !== undefined
    && effective.serviceTier !== selection.serviceTier) throw new Error('Codex acknowledged an incompatible service tier');
  let peers = admittedThreads.get(runtime);
  if (!peers) { peers = new WeakMap(); admittedThreads.set(runtime, peers); }
  const threads = peers.get(client) ?? new Set<string>();
  threads.add(threadId); peers.set(client, threads);
  return { threadId, effective };
}

/** turn/start ACK contains only the turn; later overrides remain requested. */
export async function startCodexRuntimeTurn(client: CodexClient, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<{
  turnId: string;
  requested: Readonly<{ scope: 'turn'; modelId: string; effort: string | null; serviceTier: string | null }>;
}> {
  const runtime = admittedRun(), selection = runtime.selection;
  unrouted(parameters);
  if (typeof parameters.threadId !== 'string' || !admittedThreads.get(runtime)?.get(client)?.has(parameters.threadId)) {
    throw new RuntimeAuthenticationError('The thread was not admitted by this run and peer');
  }
  await runtime.guard(client, signal);
  const response = object(await client.request('turn/start', { ...parameters, model: selection.modelId,
    ...(selection.effort !== null ? { effort: selection.effort } : {}),
    ...(selection.serviceTier !== null ? { serviceTierForTurn: selection.serviceTier } : {}),
  }, { signal }));
  const turnId = object(response.turn).id;
  if (typeof turnId !== 'string' || !turnId) throw new Error('Codex did not acknowledge a turn identifier');
  return { turnId, requested: Object.freeze({ scope: 'turn', modelId: selection.modelId,
    effort: selection.effort, serviceTier: selection.serviceTier }) };
}

/** Revocation prevents new permits; an already-admitted operation cannot be rolled back here. */
export async function dispatchCodexHostEffect<T>(client: CodexClient, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await admittedRun().guard(client, signal);
  return operation();
}
