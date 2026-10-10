/**
 * Run from packages/core after the dependency owner installs the official SDK:
 *   pnpm exec node src/runtime/adapters/pi/__fixtures__/official-sdk-contract.mjs
 * This is an accountless SDK contract probe, not a provider/auth integration test.
 * Static imports deliberately make an absent package a non-zero failure.
 * API baseline: https://github.com/earendil-works/pi/tree/v1.1.0/packages/coding-agent
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  VERSION,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
} from '@earendil-works/pi-coding-agent';

assert.equal(VERSION, '1.1.0', 'This probe requires @earendil-works/pi-coding-agent 1.1.0');

const cwd = fileURLToPath(new URL('.', import.meta.url));
const model = {
  id: 'inkos-offline-contract',
  name: 'InkOS deterministic SDK contract fixture',
  type: 'chat',
  api: 'inkos-offline-contract',
  provider: 'openai',
  baseUrl: 'http://localhost:0',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 1024,
};
// These known fixture values are never substituted for missing production usage.
const usage = {
  input: 17,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 22,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function assistant(content, responseId) {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId,
    content,
    usage: structuredClone(usage),
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 1,
  };
}

function call(id, name, args = {}) {
  return { type: 'toolCall', id, name, arguments: args };
}

function text(message) {
  return typeof message.content === 'string'
    ? message.content
    : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

function tool(name, execute, parameters = emptySchema) {
  return {
    name,
    label: name,
    description: 'Deterministic host contract fixture',
    parameters,
    executionMode: 'sequential',
    execute,
  };
}

function result(value) {
  return { content: [{ type: 'text', text: value }], details: {} };
}

function resources() {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const calls = { reload: 0, extend: 0 };
  return {
    calls,
    loader: {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'InkOS explicit host contract prompt.',
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => { calls.extend += 1; },
      reload: async () => { calls.reload += 1; },
    },
  };
}

async function runtime(responses) {
  const observed = [];
  function stream(requestModel, context, options) {
    assert.equal(requestModel.provider, 'openai');
    assert.equal(requestModel.id, model.id);
    assert.equal(options?.apiKey, undefined, 'The deterministic provider must receive no account credential');
    observed.push(structuredClone(context));
    const message = responses.shift();
    assert.ok(message, 'An unexpected additional model request occurred');
    // The opaque model/auth boundary is a fixture. Session projection, event
    // dispatch, loop, schema validation, tools, and boundaries are the official SDK.
    return {
      result: async () => message,
      async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: structuredClone(message) };
        yield { type: 'done', reason: message.stopReason, message };
      },
    };
  }
  // ModelRuntime.registerNativeProvider starts an all-provider availability scan.
  // Inject the explicit host boundary instead, so no ambient account is inspected.
  const fixtureRuntime = {
    getModel: (provider, id) => provider === 'openai' && id === model.id ? model : undefined,
    getPhysicalModel: (provider, id) => provider === 'openai' && id === model.id ? model : undefined,
    getModels: () => [model],
    getAvailableSnapshot: () => [model],
    getError: () => undefined,
    hasConfiguredAuth: (provider) => provider === 'openai',
    checkAuth: async (provider) => provider === 'openai' ? { type: 'api_key', source: 'accountless fixture' } : undefined,
    getAuth: async () => ({ auth: {}, source: 'accountless fixture' }),
    isUsingOAuth: () => false,
    streamSimple: stream,
  };
  const modelRuntime = new Proxy(Object.freeze(fixtureRuntime), {
    get(target, property, receiver) {
      if (typeof property === 'string' && !Object.hasOwn(target, property)) {
        throw new Error(`Unexpected ModelRuntime fixture operation: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { modelRuntime, observed };
}

async function sessionFor(provider, manager, hostTools, names) {
  const resource = resources();
  const settings = SettingsManager.inMemory({
    cacheWarming: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  });
  const created = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: provider.modelRuntime,
    model,
    thinkingLevel: 'off',
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: resource.loader,
    customTools: hostTools,
    tools: names,
  });
  const { session } = created;
  session.agent.toolExecution = 'sequential';
  assert.equal(settings.getCacheWarmingMode(), 'off');
  assert.equal(settings.getRetrySettings().enabled, false);
  assert.equal(settings.getCompactionSettings().enabled, false);
  assert.deepEqual(created.extensionsResult.extensions, []);
  assert.deepEqual(session.getActiveToolNames().sort(), [...names].sort());
  assert.deepEqual(session.agent.state.tools.map((entry) => entry.name).sort(), [...names].sort());
  assert.equal(resource.calls.reload, 0, 'createAgentSession must use the supplied ResourceLoader');
  return session;
}

async function completeAndRestore() {
  const manager = SessionManager.inMemory(cwd);
  const committed = [
    { role: 'user', content: 'committed InkOS user', timestamp: 1 },
    assistant([{ type: 'text', text: 'committed InkOS assistant' }], 'committed-response'),
  ];
  committed.forEach((message) => manager.appendMessage(structuredClone(message)));
  const provider = await runtime([
    assistant([
      call('save', 'host_save', { value: 7 }),
      call('finish', 'host_finish'),
      call('after-finish', 'host_side_effect'),
    ], 'completion-response'),
    assistant([{ type: 'text', text: 'restored response' }], 'restored-response'),
  ]);
  const order = [];
  const guardEntered = deferred();
  const guardRelease = deferred();
  const endEntered = deferred();
  const endRelease = deferred();
  const observerRelease = deferred();
  const observerWrites = [];
  let finished = false;
  let effects = 0;
  const hostTools = [
    tool('host_save', async (_id, args) => {
      assert.equal(args.value, 7);
      assert.ok(order.includes('receipt:save'), 'Host receipt must settle before tool execution');
      assert.ok(!order.includes('observer:save'), 'Session.subscribe must not be treated as an awaited guard');
      order.push('execute:save');
      return result('saved');
    }, { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false }),
    tool('host_finish', async () => {
      order.push('execute:finish');
      finished = true;
      return { ...result('finished'), terminate: true };
    }),
    tool('host_side_effect', async () => { effects += 1; return result('unsafe side effect'); }),
    tool('host_not_allowed', async () => { throw new Error('Whitelist violation'); }),
  ];
  const allowed = ['host_save', 'host_finish', 'host_side_effect'];
  const session = await sessionFor(provider, manager, hostTools, allowed);
  const previousBefore = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (finished) {
      order.push(`blocked:${context.toolCall.id}`);
      return { block: true, terminate: true, reason: 'Host completion already committed' };
    }
    return previousBefore?.(context, signal);
  };
  const previousFinish = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    await previousFinish?.(turn, signal);
    order.push('finishTurn');
    return finished ? { action: 'end' } : undefined;
  };
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start' && event.toolCallId === 'save') {
      const write = observerRelease.promise.then(() => { order.push('observer:save'); });
      observerWrites.push(write);
      return write;
    }
    if (event.type === 'agent_settled') order.push('agent_settled');
  });
  const unsubscribe = session.agent.subscribe(async (event) => {
    if (event.type === 'tool_execution_start' && event.toolCallId === 'save') {
      guardEntered.resolve();
      await guardRelease.promise;
      order.push('receipt:save');
    }
    if (event.type === 'agent_end') {
      order.push('agent_end:start');
      endEntered.resolve();
      await endRelease.promise;
      order.push('agent_end:written');
    }
  });
  try {
    const run = session.prompt('complete the host turn');
    await guardEntered.promise;
    assert.ok(!order.includes('execute:save'));
    assert.equal(session.isIdle, false);
    guardRelease.resolve();
    await endEntered.promise;
    let idleResolved = false;
    const idle = session.waitForIdle().then(() => { idleResolved = true; });
    await Promise.resolve();
    assert.equal(idleResolved, false, 'agent_end is not settled while its awaited listener is pending');
    assert.ok(!order.includes('agent_settled'));
    endRelease.resolve();
    await run;
    await idle;
    assert.equal(session.isIdle, true);
    assert.equal(effects, 0, 'The completion tool must block later calls from the same assistant batch');
    assert.ok(order.indexOf('execute:save') < order.indexOf('execute:finish'));
    assert.ok(order.indexOf('execute:finish') < order.indexOf('blocked:after-finish'));
    assert.ok(order.indexOf('blocked:after-finish') < order.indexOf('finishTurn'));
    assert.ok(order.indexOf('agent_end:written') < order.indexOf('agent_settled'));
    assert.equal(provider.observed.length, 1, 'finishTurn must prevent an extra assistant request');
    committed.forEach((message) => assert.ok(provider.observed[0].messages.some((item) => text(item) === text(message))));
    const afterFinish = manager.buildSessionContext().messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'after-finish');
    assert.equal(afterFinish?.isError, true);
    observerRelease.resolve();
    await Promise.all(observerWrites);
    const entries = structuredClone([manager.getHeader(), ...manager.getEntries()]);
    const canonical = structuredClone(manager.buildSessionContext().messages);
    unsubscribe();
    session.dispose();
    session.dispose();
    const restored = SessionManager.inMemory(cwd, undefined, entries);
    assert.deepEqual(restored.buildSessionContext().messages, canonical);
    const resumed = await sessionFor(provider, restored, hostTools, allowed);
    try {
      await resumed.prompt('resume from committed transcript');
      await resumed.waitForIdle();
      assert.equal(provider.observed.length, 2);
      for (const original of canonical.filter((message) => message.role !== 'system')) {
        assert.ok(provider.observed[1].messages.some((message) => message.role === original.role && text(message) === text(original)), 'Real SessionManager projection must survive restoration');
      }
      assert.ok(restored.buildSessionContext().messages.some((message) => message.role === 'assistant' && message.responseId === 'restored-response'));
    } finally {
      await resumed.abort();
      await resumed.waitForIdle();
      resumed.dispose();
    }
  } finally {
    guardRelease.resolve();
    endRelease.resolve();
    observerRelease.resolve();
    await session.abort();
    await Promise.all(observerWrites);
    unsubscribe();
    session.dispose();
  }
}

async function cancelBeforeSideEffect() {
  const provider = await runtime([assistant([call('cancelled-tool', 'host_effect')], 'cancel-response')]);
  const entered = deferred();
  const release = deferred();
  let effects = 0;
  const session = await sessionFor(provider, SessionManager.inMemory(cwd), [tool('host_effect', async () => { effects += 1; return result('effect'); })], ['host_effect']);
  const unsubscribe = session.agent.subscribe(async (event) => {
    if (event.type === 'tool_execution_start') {
      entered.resolve();
      await release.promise;
    }
  });
  try {
    const run = session.prompt('cancel before the host tool');
    await entered.promise;
    let aborted = false;
    const abort = session.abort().then(() => { aborted = true; });
    await Promise.resolve();
    assert.equal(aborted, false, 'Cancellation must await the outstanding host listener');
    release.resolve();
    await run;
    await abort;
    await session.waitForIdle();
    assert.equal(effects, 0);
    assert.equal(session.isIdle, true);
  } finally {
    release.resolve();
    await session.abort();
    unsubscribe();
    session.dispose();
    session.dispose();
  }
}

async function emptyAllowlist() {
  const provider = await runtime([assistant([{ type: 'text', text: 'no tools' }], 'empty-tools-response')]);
  const session = await sessionFor(provider, SessionManager.inMemory(cwd), [tool('host_disabled', async () => { throw new Error('Disabled custom tool executed'); })], []);
  try {
    await session.prompt('no host tools are available');
    await session.waitForIdle();
    assert.deepEqual(session.agent.state.tools, [], 'tools: [] also disables custom tools');
    assert.equal(provider.observed.length, 1);
  } finally {
    await session.abort();
    session.dispose();
  }
}

async function continueFromCommittedUser() {
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: 'user', content: 'committed unfinished user', timestamp: 1 });
  const provider = await runtime([assistant([{ type: 'text', text: 'continued response' }], 'continued-response')]);
  const session = await sessionFor(provider, manager, [], []);
  const entered = deferred();
  const release = deferred();
  let sessionSettled = false;
  session.subscribe((event) => { if (event.type === 'agent_settled') sessionSettled = true; });
  const unsubscribe = session.agent.subscribe(async (event) => {
    if (event.type === 'agent_end') {
      entered.resolve();
      await release.promise;
    }
  });
  try {
    let runResolved = false;
    const run = session.agent.continue().then(() => { runResolved = true; });
    await entered.promise;
    await session.waitForIdle();
    assert.equal(runResolved, false);
    assert.equal(sessionSettled, false);
    // Direct Agent.continue does not enter AgentSession's private prompt wrapper.
    // Host settlement/cancellation must also await agent.waitForIdle, not only the session.
    let agentIdle = false;
    const idle = session.agent.waitForIdle().then(() => { agentIdle = true; });
    await Promise.resolve();
    assert.equal(agentIdle, false);
    release.resolve();
    await run;
    await idle;
    assert.equal(sessionSettled, false, 'Direct continue has no AgentSession agent_settled event');
    assert.equal(provider.observed.length, 1);
    assert.ok(provider.observed[0].messages.some((message) => text(message) === 'committed unfinished user'));
    assert.ok(manager.buildSessionContext().messages.some((message) => message.role === 'assistant' && message.responseId === 'continued-response'));
  } finally {
    release.resolve();
    await session.abort();
    await session.agent.waitForIdle();
    unsubscribe();
    session.dispose();
  }
}

const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error('Network access forbidden in official SDK contract probe');
};
const deadline = setTimeout(() => {
  process.stderr.write('Official SDK contract probe timed out; contract was not verified.\n');
  process.exit(1);
}, 30000);
try {
  await completeAndRestore();
  await cancelBeforeSideEffect();
  await emptyAllowlist();
  await continueFromCommittedUser();
  assert.equal(networkAttempts, 0);
  process.stdout.write(JSON.stringify({
    sdk: '@earendil-works/pi-coding-agent',
    version: VERSION,
    checks: ['canonical SessionManager restore', 'host tool whitelist and sequential execution', 'awaited guard and receipt before tools', 'completion blocks same-batch effects and finishTurn ends loop', 'agent_end listener drain before settlement', 'cancel waits for host listener and idle', 'tools: [] disables custom tools', 'direct continue requires agent.waitForIdle and preserves committed context'],
    networkAttempts,
    providerAuth: 'explicit accountless ModelRuntime fixture; real ModelRuntime and ChatGPT auth unverified',
  }, null, 2) + '\n');
} finally {
  clearTimeout(deadline);
  globalThis.fetch = originalFetch;
}
