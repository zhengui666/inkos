import { afterEach, describe, expect, it } from "vitest";
import { conversationMessages, recordTaskExit, taskOutcome, taskTree } from "../runtime-view.js";
import { applyRuntimeEvent, emptyRuntimeState, eventRequiresRefresh } from "../tui/runtime-state.js";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

describe("native runtime views", () => {
  it("reads terminal outcome instead of the obsolete top-level status", () => {
    const task = { id: 1, kind: "inkos.content", status: "completed", state: { status: "terminal", outcome: { status: "aborted" } } };
    expect(taskOutcome(task)).toBe("aborted");
    recordTaskExit(task);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    recordTaskExit({ ...task, state: { status: "terminal", outcome: { status: "completed" } } });
    expect(process.exitCode).toBeUndefined();
  });
  it("renders native owner edges and held outcomes, not a flattened client scheduler", () => {
    const graph = { tasks: {
      "2": { id: 2, kind: "child", owner: 1, state: { status: "running", phase: "save" } },
      "1": { id: 1, kind: "parent", state: { status: "waiting" } },
      "3": { id: 3, kind: "ending", state: { status: "completing", outcome: "failed" }, abortRequested: true },
    } };
    expect(taskTree(graph)).toEqual(["1 parent · waiting", "  2 child · running", "3 ending · completing (failed) · abort requested"]);
  });
  it("renders raw EntryRecord.model messages and passive notes without mutating them", () => {
    const view = { entries: [
      { id: 1, kind: "pi.message", model: [{ role: "user", content: "Hi" }] },
      { id: 2, kind: "pi.message", model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }, { type: "toolCall", name: "read", arguments: { path: "a" } }] }] },
      { id: 3, kind: "inkos.note", data: { text: "Remember this" } },
    ] };
    const original = JSON.stringify(view);
    expect(conversationMessages(view).map(item => [item.role, item.content])).toEqual([
      ["user", "Hi"], ["assistant", 'Hello\n[read] {"path":"a"}'], ["note", "Remember this"],
    ]);
    expect(JSON.stringify(view)).toBe(original);
  });
  it("keeps all event handlers read-only, including replayed snapshots and changed notifications", () => {
    const state = { ...emptyRuntimeState(), conversation: { entries: [{ kind: "inkos.note", data: { text: "persisted" } }] } };
    const graph = { tasks: {} };
    const snapshot = { type: "snapshot", data: { pid: 42, taskGraph: graph } };
    const next = applyRuntimeEvent(state, snapshot);
    expect(applyRuntimeEvent(next, snapshot)).toEqual(next);
    expect(next.conversation).toBe(state.conversation);
    expect(eventRequiresRefresh({ type: "changed" })).toBe(true);
    expect(applyRuntimeEvent(next, { type: "changed" })).toBe(next);
    expect(eventRequiresRefresh({ type: "taskGraph", data: graph })).toBe(false);
    const nativeEvents = [{ type: "run_start" }, { type: "message_update", delta: "text" }];
    expect(applyRuntimeEvent(next, { type: "agentEvents", data: nativeEvents }).agentEvents).toEqual(nativeEvents);
    expect(applyRuntimeEvent(next, { type: "taskGraph", data: graph }).graph).toBe(graph);
  });
});
