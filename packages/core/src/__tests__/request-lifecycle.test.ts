import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as transcript from "../interaction/session-transcript.js";
import { CreativeEpisodeStore } from "../harness/episode-store.js";
import { finalizeAgentRequest } from "../agent/request-lifecycle.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(run: (root: string, episodes: CreativeEpisodeStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "inkos-request-finalize-"));
  const episodes = new CreativeEpisodeStore(join(root, ".inkos", "harness.sqlite"));
  try {
    await transcript.appendTranscriptEvent(root, { type: "request_started", version: 1,
      sessionId: "session", requestId: "request", seq: 1, timestamp: 1, input: "Go" });
    episodes.create({ version: 2, id: "episode-request", profileId: "script", workId: null,
      status: "running", startedAt: new Date().toISOString(), completedAt: null });
    await run(root, episodes);
  } finally { episodes.close(); await rm(root, { recursive: true, force: true }); }
}

it("settles once even when a late error arrives after durable completion", () => fixture(async (root, episodes) => {
  const input = { projectRoot: root, sessionId: "session", requestId: "request", episodes };
  expect(await finalizeAgentRequest({ ...input, status: "completed" })).toBe(2);
  await finalizeAgentRequest({ ...input, status: "failed", error: new Error("display listener failed") });
  expect((await transcript.readTranscriptEvents(root, "session")).map(e => e.type)).toEqual(["request_started", "request_committed"]);
  expect(episodes.requireEpisode("episode-request").status).toBe("completed");
  expect(episodes.listEvents("episode-request").map(e => e.type)).toEqual(["episode-completed"]);
}));

it("does not leave the episode running when terminal transcript storage fails", () => fixture(async (root, episodes) => {
  vi.spyOn(transcript, "appendTranscriptEvents").mockRejectedValueOnce(new Error("disk full"));
  await expect(finalizeAgentRequest({ projectRoot: root, sessionId: "session", requestId: "request", episodes,
    status: "failed", error: new Error("original tool failure") })).rejects.toMatchObject({
      code: "REQUEST_PERSISTENCE_FAILED", cause: expect.objectContaining({ message: "original tool failure" }),
    });
  expect(episodes.requireEpisode("episode-request").status).toBe("failed");
  await finalizeAgentRequest({ projectRoot: root, sessionId: "session", requestId: "request", episodes,
    status: "failed", error: new Error("original tool failure") });
  expect((await transcript.readTranscriptEvents(root, "session")).at(-1)?.type).toBe("request_failed");
  expect(episodes.listEvents("episode-request")).toHaveLength(1);
}));

it("writes the terminal transcript even when the episode store fails", () => fixture(async (root, episodes) => {
  vi.spyOn(episodes, "finishWithEvent").mockImplementationOnce(() => { throw new Error("database unavailable"); });
  await expect(finalizeAgentRequest({ projectRoot: root, sessionId: "session", requestId: "request", episodes,
    status: "cancelled", error: new DOMException("Stopped", "AbortError") })).rejects.toMatchObject({ code: "REQUEST_PERSISTENCE_FAILED" });
  expect((await transcript.readTranscriptEvents(root, "session")).at(-1)?.type).toBe("request_failed");
  await finalizeAgentRequest({ projectRoot: root, sessionId: "session", requestId: "request", episodes, status: "completed" });
  expect(episodes.requireEpisode("episode-request").status).toBe("cancelled");
}));

it("recovers an abandoned store even while its old Studio process remains alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-abandoned-episode-"));
  const path = join(root, "harness.sqlite"), original = new CreativeEpisodeStore(path);
  original.create({ version: 2, id: "abandoned", profileId: "script", workId: null,
    status: "running", startedAt: new Date().toISOString(), completedAt: null });
  const observer = new CreativeEpisodeStore(path);
  try {
    expect(observer.recoverInterruptedEpisodes()).toBe(0);
    original.close();
    expect(observer.recoverInterruptedEpisodes()).toBe(1);
    expect(observer.requireEpisode("abandoned").status).toBe("failed");
    expect(observer.recoverInterruptedEpisodes()).toBe(0);
  } finally { observer.close(); await rm(root, { recursive: true, force: true }); }
});

it("never changes an already cancelled episode or failed request into success", () => fixture(async (root, episodes) => {
  const input = { projectRoot: root, sessionId: "session", requestId: "request", episodes };
  await finalizeAgentRequest({ ...input, status: "cancelled", error: new DOMException("Stopped", "AbortError") });
  await finalizeAgentRequest({ ...input, status: "completed" });
  expect(episodes.requireEpisode("episode-request").status).toBe("cancelled");
  expect((await transcript.readTranscriptEvents(root, "session")).map(e => e.type)).toEqual(["request_started", "request_failed"]);
}));
