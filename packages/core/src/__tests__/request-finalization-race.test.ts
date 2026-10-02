import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentSession, abortAgentSession } from '../agent/agent-session.js';
import * as transcript from '../interaction/session-transcript.js';
import * as lifecycle from '../agent/request-lifecycle.js';
import { CreativeEpisodeStore } from '../harness/episode-store.js';
import { CodexFixture } from './codex-fixture.js';
const createClient = vi.hoisted(() => vi.fn());
vi.mock('../codex/client.js', () => ({ createCodexClient: createClient }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([['user-cancel', 'before-build'], ['deadline', 'before-build'], ['user-cancel', 'before-append'], ['deadline', 'before-append']] as const)('settles failure when %s arrives at %s', async (mode, boundary) => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-finalization-race-'));
  const controller = new AbortController(), visibleText: string[] = [];
  const fixture = new CodexFixture(() => ({ text: JSON.stringify({ status: 'answered', message: 'Saved answer' }) }));
  createClient.mockImplementation(fixture.createClient);
  const originalAppend = transcript.appendTranscriptEvents, originalFinalize = lifecycle.finalizeAgentRequest;
  let inFinalization = false, delayed = false;
  vi.spyOn(lifecycle, 'finalizeAgentRequest').mockImplementation(input => { inFinalization = true; return originalFinalize(input); });
  vi.spyOn(transcript, 'appendTranscriptEvents').mockImplementation((root, session, build, options) => originalAppend(root, session, async context => {
    const interrupt = async () => {
      if (!inFinalization || delayed) return;
      delayed = true;
      if (mode === 'user-cancel') controller.abort(new DOMException('Stopped before commit', 'AbortError'));
      else await vi.advanceTimersByTimeAsync(201);
    };
    if (boundary === 'before-build') await interrupt();
    const events = await build(context);
    if (boundary === 'before-append') await interrupt();
    return events;
  }, options));
  if (mode === 'deadline') {
    vi.stubEnv('INKOS_AGENT_TIMEOUT_MS', '200');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  try {
    const run = runAgentSession({ projectRoot: root, sessionId: 'race', bookId: null, workId: null,
      profileId: 'workspace-default', sessionKind: 'chat', language: 'en', pipeline: {} as never, signal: controller.signal,
      onEvent: event => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') visibleText.push(event.assistantMessageEvent.delta); },
    }, 'Please answer');
    await expect(run).rejects.toMatchObject(mode === 'user-cancel' ? { name: 'AbortError' } : { code: 'AGENT_REQUEST_TIMEOUT' });
    expect(delayed).toBe(true);
    const events = await transcript.readTranscriptEvents(root, 'race');
    expect(events.filter(event => event.type === 'request_committed')).toHaveLength(0);
    expect(events.filter(event => event.type === 'request_failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'request_failed', code: mode === 'user-cancel' ? 'REQUEST_CANCELLED' : 'AGENT_REQUEST_TIMEOUT' });
    const episodes = new CreativeEpisodeStore(join(root, '.inkos', 'harness.sqlite'));
    try { expect(episodes.listEpisodes().map(e => e.status)).toEqual([mode === 'user-cancel' ? 'cancelled' : 'failed']); }
    finally { episodes.close(); }
    expect(visibleText).toEqual([]);
    expect(fixture.requests.filter(r => r.method === 'turn/start')).toHaveLength(1);
  } finally { abortAgentSession(root, 'race'); await rm(root, { recursive: true, force: true }); }
});
