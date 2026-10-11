import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRuntimeExecution, observePiRuntime, RuntimeHistoryWriteError } from '../execution.js';
import { currentRuntimeRun, runWithRuntimeContext } from '../run-context.js';
import { createRuntimeAgent, resolveRuntimeModel } from '../provider.js';
import { runWorkerAgent, runWorkerAgentTool } from '../../agent/worker-agent.js';
import { runAgentSession, abortAgentSession } from '../../agent/agent-session.js';
import { CreativeEpisodeStore } from '../../harness/episode-store.js';
import { HARNESS_VERSION } from '../../harness/contracts.js';
import { catalog } from './fixtures.js';
import { runWithAgentTrajectory } from '../../llm/agent-trajectory.js';
import { RUN_HISTORY_EVENT_TYPE, appendRunSelection, type RunHistoryBinding } from '../run-history.js';
import * as settings from '../settings.js';
import { PiRuntimeAdapter } from '../registry.js';
import { officialModelFixture } from '../adapters/pi/__fixtures__/official-model.js';
import type { PiAssistantMessage } from '../adapters/pi/contracts.js';
import type { LLMClient } from '../../llm/provider.js';
import * as completionTools from '../../agent/turn-completion.js';
import { readTranscriptEvents } from '../../interaction/session-transcript.js';
import { PiCleanupError } from '../adapters/pi/provider.js';
import { loadPiNativeAuthStorage } from '../auth/pi-native-store-compat.js';

vi.mock('../auth/pi-native-store-compat.js', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../auth/pi-native-store-compat.ts');
});
const codex = vi.hoisted(() => vi.fn(async () => { throw new Error('Codex fallback forbidden'); }));
vi.mock('../../codex/client.js', () => ({ createCodexClient: codex }));
let root: string, agentDir: string, network: ReturnType<typeof vi.fn>;
const sessions = new Set<string>(), stores: CreativeEpisodeStore[] = [];
const credential = (suffix = 'first', expires = Date.now() + 3_600_000) => ({ type: 'oauth', access: `synthetic-access-${suffix}`, refresh: `synthetic-refresh-${suffix}`, expires });
function response(content: PiAssistantMessage['content'] = [{ type: 'text', text: 'Answer saved' }], usage = true): PiAssistantMessage {
  return { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-5.4', content,
    stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
    ...(usage ? { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) };
}
function transport(responses: PiAssistantMessage[]) {
  const fixture = officialModelFixture(responses);
  const stream = vi.spyOn(ModelRuntime.prototype, 'streamSimple').mockImplementation(fixture.runtime.streamSimple);
  return { fixture, stream };
}
const client = (): LLMClient => ({ provider: 'openai', service: 'pi', apiFormat: 'responses', stream: true,
  _runtime: { projectRoot: root, harnessId: 'pi' }, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } });
const nativeUsage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
/** Fake fetch bytes; OAuth derivation, Responses parser, SDK agent and host projection are real. */
function rawResponses(reports: Array<{ usage?: unknown; text?: string; id?: string }>) {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const report = reports.shift(); if (!report) throw new Error('Unexpected real SDK request');
    const id = report.id ?? 'same-id-across-requests', text = report.text ?? 'Answer saved';
    const item = { type: 'message', id: 'message-native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item], ...(report.usage === undefined ? {} : { usage: report.usage }) } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event).replace('"NONFINITE"', '1e999')}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
async function agent(tools: Parameters<typeof createRuntimeAgent>[0]['initialState']['tools'] = []) {
  return createRuntimeAgent({ projectRoot: root, initialState: { model: resolveRuntimeModel(), systemPrompt: 'Original host prompt', tools, messages: [] } });
}
function history(): RunHistoryBinding {
  const store = new CreativeEpisodeStore(join(root, '.inkos', 'harness.sqlite')); stores.push(store);
  store.create({ version: HARNESS_VERSION, id: 'episode-r1', workId: null, profileId: null, status: 'running', startedAt: new Date().toISOString(), completedAt: null });
  return { store, episodeId: 'episode-r1', coreRequestId: 'r1', sessionId: 's1' };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-pi-runtime-')); agentDir = join(root, 'agent'); await mkdir(agentDir);
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential() }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-5.4', defaultThinkingLevel: 'low' }));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir); codex.mockClear();
  network = vi.fn(async () => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', network);
  await settings.updateAgentSettings(root, { selectedHarnessId: 'pi' }, { expectedRevision: 0 });
});
afterEach(async () => {
  for (const session of sessions) abortAgentSession(root, session); sessions.clear();
  for (const store of stores.splice(0)) store.close();
  expect(network).not.toHaveBeenCalled(); expect(codex).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});

describe('Pi generic admission and real SDK host integration (accountless transport)', () => {
  it.each([true, false])('review correction continues an assistant tail without a new author message (usage=%s)', async known => {
    const first = response([{ type: 'text', text: 'Invalid ordinary completion' }], known);
    const final = response([{ type: 'text', text: JSON.stringify({ status: 'answered', message: 'Corrected answer' }) }], known);
    const model = transport([first, final]), create = vi.spyOn(SessionManager, 'inMemory');
    const append = vi.spyOn(CreativeEpisodeStore.prototype, 'append'); sessions.add('review-correction');
    const result = await runAgentSession({ projectRoot: root, sessionId: 'review-correction', bookId: null, workId: null,
      profileId: 'workspace-default', sessionKind: 'chat', language: 'en', pipeline: {} as never }, 'Original author request');
    expect(result.completion).toEqual({ status: 'answered', message: 'Corrected answer' }); expect(model.stream).toHaveBeenCalledTimes(2);
    const contexts = model.fixture.observed as Array<{ messages: Array<{ role: string; content?: unknown; toolsAdded?: Array<{ name: string }> }> }>;
    expect(contexts[1].messages.filter(message => message.role === 'user')).toEqual(contexts[0].messages.filter(message => message.role === 'user'));
    expect(contexts[1].messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(contexts[1].messages)).toContain('Invalid ordinary completion');
    expect(JSON.stringify(contexts[1].messages)).toContain('The host did not accept a completion');
    const declarations = contexts.map(context => context.messages.flatMap(message => message.toolsAdded ?? []));
    expect(declarations[1]).toEqual(declarations[0]); expect(declarations[1].some(tool => tool.name === 'finish_turn')).toBe(true);
    expect(result.messages.some(message => (message as { role: string }).role === 'system')).toBe(false);
    expect(result.messages.filter(message => message.role === 'toolResult')).toHaveLength(0);
    const generated = result.messages.filter((message): message is Extract<typeof message, { role: 'assistant' }> => message.role === 'assistant' && message.content.some(part => part.type === 'text'));
    expect(generated).toHaveLength(2); for (const message of generated) expect(message.usage).toEqual(known ? first.usage : undefined);
    expect(append.mock.calls.filter(([event]) => event.type === 'turn-completion-accepted')).toHaveLength(1);
    const managers = create.mock.results.map(result => result.value as SessionManager).filter(manager => manager.getBranch().some(entry => entry.type === 'message' && entry.message.role === 'user'));
    expect(managers).toHaveLength(2); expect(new Set(managers.map(manager => manager.getSessionId())).size).toBe(2);
    expect(append.mock.calls.filter(([event]) => event.type === RUN_HISTORY_EVENT_TYPE && event.payload.kind === 'dispatch').map(([event]) => event.payload.piSessionId)).toEqual(managers.map(manager => manager.getSessionId()));
    const entries = managers[1].getBranch().flatMap(entry => entry.type === 'message' ? [entry] : []);
    const restored = entries.findIndex(entry => entry.message.role === 'assistant' && JSON.stringify(entry.message).includes('Invalid ordinary completion'));
    expect(restored).toBeGreaterThanOrEqual(0); expect(entries[restored + 1].message.role).toBe('system');
    expect(JSON.stringify(entries[restored + 1].message)).toContain('The host did not accept a completion'); expect(entries[restored + 1].id).toBeTruthy();
    const events = await readTranscriptEvents(root, 'review-correction');
    expect(events.filter(event => event.type === 'request_committed')).toHaveLength(1);
  });
  it('review correction stops after the existing second invalid completion', async () => {
    const model = transport([response(), response()]); sessions.add('review-invalid');
    const result = await runAgentSession({ projectRoot: root, sessionId: 'review-invalid', bookId: null, workId: null,
      profileId: 'workspace-default', sessionKind: 'chat', language: 'en', pipeline: {} as never }, 'Original request');
    expect(model.stream).toHaveBeenCalledTimes(2); expect(result.completion).toBeUndefined();
    expect(result.completionDiagnostics).toMatchObject({ code: 'TURN_COMPLETION_INVALID', modelTurns: 2, finalResponses: 2 });
    expect((await readTranscriptEvents(root, 'review-invalid')).some(event => event.type === 'request_committed')).toBe(false);
  });
  it('review continuation from a real tool-result tail keeps the existing path and does not replay the tool', async () => {
    const model = transport([response()]), execute = vi.fn(async () => ({ content: [], details: {} }));
    await withRuntimeExecution(root, async () => {
      const main = await agent([{ name: 'host_effect', label: 'Effect', description: 'Effect', parameters: Type.Object({}), execute }]);
      main.state.messages = [{ role: 'user', content: 'Original request', timestamp: Date.now() },
        response([{ type: 'toolCall', id: 'already-saved', name: 'host_effect', arguments: {} }]) as never,
        { role: 'toolResult', toolCallId: 'already-saved', toolName: 'host_effect', content: [{ type: 'text', text: 'Saved effect receipt' }], isError: false, timestamp: Date.now() }];
      await main.continue(); expect(main.finalOutput).toBe('Answer saved');
    });
    expect(model.stream).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
  it.each(['auth', 'history'] as const)('review native completion retains post-validator %s failure and saved effects', async mode => {
    const model = transport([response([{ type: 'text', text: JSON.stringify({ status: 'delivered', message: 'Saved delivery' }) }])]);
    let enter!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let validations = 0, poison: RuntimeHistoryWriteError | undefined;
    const original = completionTools.createTurnCompletionTool;
    vi.spyOn(completionTools, 'createTurnCompletionTool').mockImplementation(options => original({ ...options,
      state: () => ({ ...options.state(), hasDelivery: true }),
      validateDelivery: async () => {
        validations++; await options.validateDelivery?.(); await writeFile(join(root, 'review-business-receipt.txt'), 'saved candidate');
        enter(); await gate;
        if (mode === 'history') { poison = new RuntimeHistoryWriteError('Saved candidate history became uncertain'); currentRuntimeRun()!.onHistoryFailure!(poison); }
      },
    }));
    const append = vi.spyOn(CreativeEpisodeStore.prototype, 'append'), events: unknown[] = []; sessions.add('review-validator');
    const result = runAgentSession({ projectRoot: root, sessionId: 'review-validator', bookId: null, workId: null,
      profileId: 'workspace-default', sessionKind: 'chat', language: 'en', pipeline: {} as never, onEvent: event => { events.push(event); } }, 'Deliver').catch(error => error);
    await began;
    if (mode === 'auth') await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('external') }));
    release(); const failure = await result;
    if (mode === 'history') expect(failure).toBe(poison); else expect(failure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(validations).toBe(1); expect(model.stream).toHaveBeenCalledOnce();
    expect(await readFile(join(root, 'review-business-receipt.txt'), 'utf8')).toBe('saved candidate');
    expect(append.mock.calls.some(([event]) => event.type === 'turn-completion-accepted')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('text_delta');
    const transcript = await readTranscriptEvents(root, 'review-validator');
    expect(transcript.some(event => event.type === 'request_committed')).toBe(false);
    expect(transcript.at(-1)?.type).toBe('request_failed');
  });
  it('review cancellation waits for actual detached native saving and retains its cleanup failure', async () => {
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('expired', 1) }));
    const { AuthStorage } = await loadPiNativeAuthStorage(), modify = AuthStorage.prototype.modify;
    let enter!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(AuthStorage.prototype, 'modify').mockImplementation(async function (this: typeof AuthStorage.prototype, ...args) {
      await modify.apply(this, args); enter(); await gate; throw new Error('Actual native save completion is uncertain');
    });
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!; if (run.harnessId !== 'pi') throw new Error();
      const runtime = run.runtime.modelRuntime as ModelRuntime;
      runtime.getProvider('openai')!.auth.oauth!.refresh = async () => credential('rotated') as never;
      runtime.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
      const controller = new AbortController(), cancellation = new DOMException('Caller cancelled model request', 'AbortError');
      const main = await createRuntimeAgent({ projectRoot: root, signal: controller.signal,
        initialState: { model: resolveRuntimeModel(), systemPrompt: 'Question', tools: [], messages: [] } });
      let settled = false; const result = main.prompt('Question').catch(error => error).finally(() => { settled = true; });
      await began; controller.abort(cancellation); await Promise.resolve(); expect(settled).toBe(false); release();
      const failure = await result; expect(failure).toBeInstanceOf(PiCleanupError);
      expect(failure.primaryFailure).toBe(cancellation); expect(failure.cleanupFailure).toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
      expect(JSON.stringify(failure)).not.toContain('synthetic');
    });
  });
  it('review an already observed authentication failure remains primary when the caller also cancels', async () => {
    const model = transport([response([{ type: 'toolCall', id: 'revoke-then-cancel', name: 'host_effect', arguments: {} }])]);
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!; if (run.harnessId !== 'pi') throw new Error();
      const original = run.guard.bind(run), controller = new AbortController();
      vi.spyOn(run, 'guard').mockImplementation(async (...args) => {
        try { await original(...args); } catch (error) { controller.abort(new DOMException('Later cancellation', 'AbortError')); throw error; }
      });
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const main = await createRuntimeAgent({ projectRoot: root, signal: controller.signal,
        initialState: { model: resolveRuntimeModel(), systemPrompt: 'Effect', messages: [], tools: [{ name: 'host_effect', label: 'Effect', description: 'Effect', parameters: Type.Object({}),
          prepareArguments: async args => { await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('external') })); return args; }, execute }] } });
      await expect(main.prompt('Effect')).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
      expect(controller.signal.aborted).toBe(true); expect(execute).not.toHaveBeenCalled();
    });
    expect(model.stream).toHaveBeenCalledOnce();
  });
  it('observes actual capabilities without binding or creating an owner/auth/config file', async () => {
    const auth = await readFile(join(agentDir, 'auth.json'), 'utf8'), config = await readFile(join(root, '.inkos', 'agent-config.json'), 'utf8');
    const files = await readdir(agentDir), observed = await observePiRuntime(root);
    expect(observed.ready).toBe(true); expect(observed.descriptor?.runtimeVersion).toBe('1.1.0');
    expect(observed.descriptor?.capabilities?.models.length).toBeGreaterThan(0);
    expect(await readFile(join(agentDir, 'auth.json'), 'utf8')).toBe(auth); expect(await readdir(agentDir)).toEqual(files);
    expect(await readFile(join(root, '.inkos', 'agent-config.json'), 'utf8')).toBe(config);
    expect((await settings.readAgentSettings(root)).modelConnectionRef).toBeNull();
    await rm(agentDir, { recursive: true }); expect((await observePiRuntime(root)).ready).toBe(false);
    expect(await readdir(root)).not.toContain('agent');
  });
  it('freezes Pi defaults and preserves both preferences across later settings saves and nested runs', async () => {
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!; expect(run.harnessId).toBe('pi');
      expect(run.selection).toMatchObject({ harnessId: 'pi', modelId: 'gpt-5.4', effort: 'low', serviceTier: null });
      expect(Object.isFrozen(run.selection)).toBe(true); expect(JSON.stringify(run.selection)).not.toContain('synthetic');
      if (run.harnessId !== 'pi') throw new Error();
      const descriptor = await new PiRuntimeAdapter(run.runtime).describe();
      await settings.updateAgentSettings(root, { harnessPreferences: { pi: { effort: 'high' } } }, { expectedRevision: run.selection.configRevision, catalogs: { pi: descriptor.capabilities! } });
      await withRuntimeExecution(root, async () => { expect(currentRuntimeRun()!.selection).toBe(run.selection); await run.guard(); });
      expect(run.selection.effort).toBe('low');
    });
    const saved = await settings.readAgentSettings(root); expect(saved.harnessPreferences.pi.effort).toBe('high');
    expect(saved.harnessPreferences.codex).toEqual({ model: 'gpt-6.1-sol', effort: 'ultra', speed: 'priority' });
  });
  it('terminates a CAS harness switch without starting either engine', async () => {
    const update = settings.updateAgentSettings;
    vi.spyOn(settings, 'updateAgentSettings').mockImplementationOnce(async (project, patch, options) => {
      await update(project, { selectedHarnessId: 'codex' }, { expectedRevision: options.expectedRevision, catalogs: { codex: catalog('codex') } });
      return update(project, patch, options);
    });
    const task = vi.fn(); await expect(withRuntimeExecution(root, task)).rejects.toThrow('selected harness changed'); expect(task).not.toHaveBeenCalled();
  });
  it('runs main and nested facades with the same selection and independent actual sessions, synchronizing host state', async () => {
    const model = transport([response(), response(), response()]);
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!, create = vi.spyOn(SessionManager, 'inMemory'), main = await agent();
      await main.prompt('First question'); const first = main.state.messages;
      main.state.messages = [...first, { role: 'user', content: 'Host committed continuation', timestamp: Date.now() }];
      main.state.systemPrompt = 'Changed host system prompt'; await main.continue();
      await withRuntimeExecution(root, async () => { expect(currentRuntimeRun()!.selection).toBe(run.selection); const child = await agent(); await child.prompt('Independent worker'); });
      const managers = create.mock.results.map(result => result.value as SessionManager);
      expect(new Set(managers.map(manager => manager.getSessionId())).size).toBe(3);
      expect(JSON.stringify(model.fixture.observed[1])).toContain('Host committed continuation');
      expect(JSON.stringify(model.fixture.observed[1])).toContain('Changed host system prompt');
      expect(model.stream).toHaveBeenCalledTimes(3);
    });
  });
  it('uses the real main-agent queue and completion projection on Pi', async () => {
    transport([response([{ type: 'text', text: JSON.stringify({ status: 'answered', message: 'Answer saved' }) }])]);
    sessions.add('pi-main');
    const result = await runAgentSession({ projectRoot: root, sessionId: 'pi-main', bookId: null, workId: null,
      profileId: 'workspace-default', sessionKind: 'chat', language: 'en', pipeline: {} as never }, 'Answer this request');
    expect(result.completion).toMatchObject({ status: 'answered', message: 'Answer saved' });
    expect(result.responseText).toContain('Answer saved');
  });
  it('persists dispatch before model startup and observes only actual run session/entry IDs', async () => {
    const model = transport([response()]);
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!, binding = history();
      appendRunSelection(binding, { schemaVersion: 1, kind: 'selection', sessionId: 's1', coreRequestId: 'r1',
        saved: { ...run.saved, harnessId: 'pi', revision: run.selection.configRevision }, selection: run.selection });
      const entries = vi.spyOn(SessionManager.prototype, 'appendModelChange');
      const thinkingEntries = vi.spyOn(SessionManager.prototype, 'appendThinkingLevelChange');
      const stream = model.stream.getMockImplementation()!;
      model.stream.mockImplementation((...args) => {
        expect(binding.store.listEvents(binding.episodeId).some(event => event.payload.kind === 'dispatch')).toBe(true); return stream(...args);
      });
      await runWithRuntimeContext({ ...run, history: binding }, () => runWithAgentTrajectory({ conversationId: 'c1', runId: 'r1', agentRole: 'main' }, async () => { const main = await agent(); await main.prompt('Question'); }));
      const events = binding.store.listEvents(binding.episodeId).filter(event => event.type === RUN_HISTORY_EVENT_TYPE), dispatch = events.find(event => event.payload.kind === 'dispatch')!;
      const observed = events.filter(event => event.payload.source === 'pi-session-entry');
      // Reconstructed native sessions write a thinking entry, but no model-change entry.
      // Keep unrecorded model evidence unknown rather than borrowing a defaults-probe ID.
      expect(entries).not.toHaveBeenCalled(); expect(observed).toHaveLength(1);
      expect(observed.every(event => event.payload.piSessionId === dispatch.payload.piSessionId)).toBe(true);
      expect(observed[0].payload.entryId).toBe(thinkingEntries.mock.results[0].value);
      expect(observed[0].payload.effective).toEqual({ effort: 'low' });
      expect(observed[0].seq).toBeGreaterThan(dispatch.seq);
    });
  });
  it('retains a failed durable dispatch and never calls the model or retries', async () => {
    const model = transport([response()]);
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!, binding = history();
      vi.spyOn(binding.store, 'append').mockImplementation(() => { throw new Error('Durable dispatch failed'); });
      await expect(runWithRuntimeContext({ ...run, history: binding }, () => runWithAgentTrajectory({ conversationId: 'c1', runId: 'r1', agentRole: 'main' }, async () => { const main = await agent(); await main.prompt('Question'); }))).rejects.toMatchObject({ code: 'RUNTIME_HISTORY_WRITE_FAILED' });
      expect(model.stream).not.toHaveBeenCalled();
    });
  });
  it.each(['prepare', 'execute'])('guards owner changes during host %s and preserves actual effects without replay', async stage => {
    const model = transport([response([{ type: 'toolCall', id: 'effect-1', name: 'host_effect', arguments: {} }])]); let prepared = 0, executed = 0;
    const receipt = join(root, 'actual-effect-receipt.txt');
    await expect(withRuntimeExecution(root, async () => {
      const main = await agent([{ name: 'host_effect', label: 'Effect', description: 'Host effect', parameters: Type.Object({}),
        prepareArguments: async args => { prepared++; if (stage === 'prepare') { await writeFile(receipt, 'prepared'); await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('external') })); } return args; },
        execute: async () => { executed++; await writeFile(receipt, 'executed'); await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('external') })); return { content: [{ type: 'text', text: 'Effect saved' }], details: { receipt: 'effect-1' } }; } }]);
      await main.prompt('Perform the effect');
    })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(prepared).toBe(1); expect(executed).toBe(stage === 'prepare' ? 0 : 1); expect(await readFile(receipt, 'utf8')).toBe(stage === 'prepare' ? 'prepared' : 'executed');
    expect(model.stream).toHaveBeenCalledOnce();
  });
  it('guards worker validator acceptance after a credential change and keeps its persisted effect', async () => {
    const model = transport([response([{ type: 'toolCall', id: 'result-1', name: 'submit_result', arguments: { answer: 'saved' } }])]); let validations = 0;
    await expect(runWorkerAgentTool(client(), 'legacy-model', [{ role: 'user', content: 'Return the result' }], {
      name: 'submit_result', label: 'Result', description: 'Host result', parameters: Type.Object({ answer: Type.String() }),
      validate: async value => { validations++; await writeFile(join(root, 'validator-receipt.txt'), value.answer); await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('external') })); return value; },
    })).rejects.toMatchObject({ code: 'RUNTIME_AUTH_REVOKED' });
    expect(validations).toBe(1); expect(await readFile(join(root, 'validator-receipt.txt'), 'utf8')).toBe('saved'); expect(model.stream).toHaveBeenCalledOnce();
  });
  it('preserves missing usage as unknown in the actual worker response', async () => {
    transport([response(undefined, false)]);
    const result = await runWorkerAgent(client(), 'legacy-model', [{ role: 'user', content: 'Question' }]);
    expect(result.content).toBe('Answer saved'); expect(result.usage).toBeUndefined();
  });
  it.each([
    { name: 'missing native usage', usage: undefined, expected: undefined },
    ...(['input_tokens', 'output_tokens', 'total_tokens'] as const).map(key => ({ name: `missing ${key}`, usage: Object.fromEntries(Object.entries(nativeUsage).filter(([field]) => field !== key)), expected: undefined })),
    { name: 'nonfinite native count', usage: { ...nativeUsage, total_tokens: 'NONFINITE' }, expected: undefined },
    { name: 'explicit zero report', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, expected: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    { name: 'complete report', usage: nativeUsage, expected: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
  ])('projects real Responses evidence: $name', async ({ usage, expected }) => {
    const fetch = rawResponses([{ usage }]);
    const result = await runWorkerAgent(client(), 'legacy', [{ role: 'assistant', content: 'Historical assistant placeholder' }, { role: 'user', content: 'Question' }]);
    expect(result).toEqual({ content: 'Answer saved', usage: expected }); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { name: 'known + known', reports: [nativeUsage, nativeUsage], expected: { promptTokens: 14, completionTokens: 6, totalTokens: 20 } },
    { name: 'known + unknown', reports: [nativeUsage, undefined], expected: undefined },
    { name: 'unknown + known', reports: [undefined, nativeUsage], expected: undefined },
    { name: 'all unknown', reports: [undefined, undefined], expected: undefined },
  ])('keeps correction totals and request evidence isolated: $name', async ({ reports, expected }) => {
    const fetch = rawResponses(reports.map((usage, index) => ({ usage, text: JSON.stringify({ resultJson: JSON.stringify({ answer: index ? 'accepted' : 'rejected' }) }) })));
    const onUsage = vi.fn(); let validations = 0;
    const result = await runWorkerAgentTool(client(), 'legacy', [{ role: 'assistant', content: 'Old receipt without current evidence' }, { role: 'user', content: 'Return answer' }], {
      name: 'submit_result', label: 'Result', description: 'Result', parameters: Type.Object({ answer: Type.String() }),
      validate: value => { validations++; if (value.answer === 'rejected') throw new Error('Correct the answer'); return value; },
    }, { onUsage });
    expect(result).toEqual({ answer: 'accepted' }); expect(validations).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expected);
  });
  it('awaits the original provider hook and retains its failure', async () => {
    rawResponses([{ usage: nativeUsage }, { usage: nativeUsage }]);
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!; if (run.harnessId !== 'pi') throw new Error();
      const runtime = run.runtime.modelRuntime as ModelRuntime, model = runtime.getModel('openai', 'gpt-5.4')!;
      const observed: string[] = [];
      const first = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Question', timestamp: Date.now() }] }, {
        onProviderStreamEvent: async data => { await Promise.resolve(); observed.push((data as { type: string }).type); },
      });
      expect(observed).toContain('response.completed'); expect(run.runtime.projectMessage(first).role).toBe('assistant');
      expect(run.runtime.projectMessage(first)).toMatchObject({ usage: { input: 7, output: 3, totalTokens: 10 } });
      const second = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Question', timestamp: Date.now() }] }, {
        onProviderStreamEvent: async () => { throw new Error('Original hook failure'); },
      });
      expect(second.stopReason).toBe('error'); expect(second.errorMessage).toContain('Original hook failure');
      expect(run.runtime.projectMessage(second)).not.toHaveProperty('usage');
    });
  });
  it('rechecks shared history poison after an asynchronous refresh guard waits', async () => {
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: credential('expired', 1) }));
    await withRuntimeExecution(root, async () => {
      const run = currentRuntimeRun()!; if (run.harnessId !== 'pi') throw new Error();
      const native = run.runtime.modelRuntime as ModelRuntime; let enter!: () => void, release!: () => void;
      const began = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      native.getProvider('openai')!.auth.oauth!.refresh = async () => { enter(); await gate; return credential('rotated') as never; };
      native.getProvider('openai')!.auth.oauth!.toAuth = async value => ({ apiKey: value.access });
      const auth = native.getAuth('openai').catch(error => error); await began;
      const guard = run.guard().catch(error => error), poison = new RuntimeHistoryWriteError('Sibling receipt failed'); run.onHistoryFailure!(poison);
      release(); await auth; expect(await guard).toBe(poison); await expect(run.guard()).rejects.toBe(poison);
    });
  });
  it('retains cleanup failure ahead of cancellation and keeps the original primary failure', async () => {
    transport([response([{ type: 'toolCall', id: 'cancel-1', name: 'cancel_host', arguments: {} }])]);
    await expect(withRuntimeExecution(root, async () => {
      const controller = new AbortController();
      vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(() => { throw new Error('Synthetic cleanup failure'); });
      const main = await createRuntimeAgent({ projectRoot: root, signal: controller.signal, initialState: { model: resolveRuntimeModel(), systemPrompt: 'Cancel', messages: [],
        tools: [{ name: 'cancel_host', label: 'Cancel', description: 'Cancel', parameters: Type.Object({}), prepareArguments: args => { controller.abort(); return args; }, execute: async () => ({ content: [], details: {} }) }] } });
      await main.prompt('Cancel');
    })).rejects.toMatchObject({ code: 'PI_CLEANUP_FAILED', primaryFailure: { name: 'AbortError' } });
  });
});
