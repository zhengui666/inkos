import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeClient } from "@actalk/inkos-core";
import { initializeProjectDirectory } from "../project-bootstrap.js";
import { watchRuntimeEvents } from "../events.js";
import { InkTuiApp } from "../tui/dashboard.js";
import { submitTuiInput } from "../tui/runtime-input.js";
import { applyRuntimeEvent, emptyRuntimeState, loadRuntimeState } from "../tui/runtime-state.js";
import { stopProject, tempProject } from "./runtime-flow.js";

let root: string, client: RuntimeClient;
beforeEach(async () => { root = await tempProject(); await initializeProjectDirectory(root); client = await RuntimeClient.connect(root); });
afterEach(async () => { await stopProject(root); });

describe("TUI with real durable runtime watches and submissions (no model/site or mocked core)", () => {
  it("loads persistent conversations, accepts Ink input notes, and detaches without stopping the runtime", async () => {
    const created = await submitTuiInput(client, "/new", { requestId: "new-conversation" });
    const conversationId = created.conversationId!;
    const note = await submitTuiInput(client, "/note Existing note", { conversationId, requestId: "first-note" });
    await client.rpc("submissions.wait", { id: note.submission!.id });
    const replay = await submitTuiInput(client, "/note Existing note", { conversationId, requestId: "first-note" });
    expect(replay.submission!.id).toBe(note.submission!.id);
    const watch = new AbortController();
    const app = render(React.createElement(InkTuiApp, { client, projectName: "Local", locale: "en", initialConversationId: conversationId, signal: watch.signal }));
    try {
      await expect.poll(() => app.lastFrame()).toContain("Existing note");
      app.stdin.write("/note Typed in Ink");
      await expect.poll(() => app.lastFrame()).toContain("/note Typed in Ink");
      app.stdin.write("\r");
      await expect.poll(async () => (await loadRuntimeState(client, conversationId)).conversation?.entries.filter((entry: any) => entry.kind === "inkos.note").length).toBe(2);
      await expect.poll(() => app.lastFrame()).toContain("Typed in Ink");
      app.stdin.write("\u0003");
    } finally { watch.abort(); app.unmount(); app.cleanup(); }
    expect((await RuntimeClient.find(root))?.endpoint.pid).toBe(client.endpoint.pid);
    expect((await loadRuntimeState(client, conversationId)).conversation?.entries.filter((entry: any) => entry.kind === "inkos.note").length).toBe(2);
  });

  it("reconnects read-only SSE after a real runtime restart, never duplicates a submission or aborts a paused task", async () => {
    const { id } = await client.rpc<{ id: number }>("conversations.create");
    const note = await submitTuiInput(client, "/note Persisted once", { conversationId: id, requestId: "durable-note" });
    await client.rpc("submissions.wait", { id: note.submission!.id });
    await client.rpc("works.create", { id: "paused", title: "Paused Work", plan: { review: { enabled: false } } });
    await submitTuiInput(client, "/work-pause paused", { requestId: "pause" });
    const started = await client.rpc<{ taskId: number }>("creation.start", { workId: "paused", content: "Explicit imported manuscript", requestId: "paused-content" });
    const watch = new AbortController();
    let snapshots = 0, state = emptyRuntimeState();
    const stream = watchRuntimeEvents(client, event => {
      state = applyRuntimeEvent(state, event);
      if (event.type === "snapshot") snapshots++;
    }, { conversationId: id, signal: watch.signal });
    try {
      await expect.poll(() => snapshots).toBe(1);
      expect(state.status?.pid).toBe(client.endpoint.pid);
      const previousPid = client.endpoint.pid;
      await client.stop();
      await expect.poll(() => RuntimeClient.find(root)).toBeUndefined();
      client = await RuntimeClient.connect(root);
      expect(client.endpoint.pid).not.toBe(previousPid);
      await expect.poll(() => snapshots, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      expect(state.status?.pid).toBe(client.endpoint.pid);
    } finally { watch.abort(); await stream; }
    const view = await loadRuntimeState(client, id);
    expect(view.conversation?.entries.filter((entry: any) => entry.kind === "inkos.note").map((entry: any) => entry.data.text)).toEqual(["Persisted once"]);
    expect((await client.rpc("tasks.get", { id: started.taskId })).state.outcome).toBeUndefined();
    await submitTuiInput(client, `/cancel ${started.taskId}`, { requestId: "native-abort" });
    expect((await client.rpc("tasks.wait", { id: started.taskId })).state.outcome.status).toBe("aborted");
  });
});
