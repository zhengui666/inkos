import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeClient } from "@actalk/inkos-core";
import { findStudio, stopStudio } from "../commands/studio.js";
import { runCli, stopProject, tempProject } from "./runtime-flow.js";

let root: string;
beforeEach(async () => { root = await tempProject(); await runCli(root, ["init"]); });
afterEach(async () => { await stopStudio(root); await stopProject(root); });

describe("compiled CLI with the real core dist service, SQLite, and official SDK (no models/sites)", () => {
  it("initializes offline, and concurrent CLI clients connect to one independent runtime PID", async () => {
    expect(await runCli(root, ["status"])).toEqual({ running: false, rootDir: root });
    await expect(stat(join(root, ".inkos", "durable.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    const [first, second] = await Promise.all([runCli(root, ["up", "--no-studio"]), runCli(root, ["daemon", "start", "--no-studio"])]);
    expect(first.pid).toBe(second.pid);
    expect(first.studio).toBeUndefined();
    expect(await findStudio(root)).toBeUndefined();
    const status = await runCli(root, ["daemon", "status"]);
    expect(status.pid).toBe(first.pid);
    for (const key of ["rootDir", "works", "targets", "distributions", "tasks", "taskGraph", "usage", "plugins", "model"]) expect(status).toHaveProperty(key);
    expect((await stat(join(root, ".inkos", "durable.sqlite"))).isFile()).toBe(true);
  });

  it("round-trips all built-in Work profiles, plans and explicit imported/manual artifact revisions offline", async () => {
    for (const profile of ["fiction", "short-fiction", "script", "storyboard", "interactive-film", "play", "translation", "article"]) {
      const work = await runCli(root, ["work", "create", "--id", profile, "--title", profile, "--profile", profile, "--locale", "en", "--domain", '{"author":"local"}', "--review", '{"enabled":false}']);
      expect(work).toMatchObject({ id: profile, profile, locale: "en", domain: { author: "local" } });
      expect(work.targetIds).toEqual([]);
    }
    expect((await runCli(root, ["work", "list"])).length).toBe(8);
    const goal = await runCli(root, ["goal", "set", "fiction", "--serial", "--units", "null", "--backlog", "0", "--cron", "null"]);
    expect(goal.plan).toMatchObject({ serial: true, units: null, production: { backlog: 0, cron: null } });
    const updated = await runCli(root, ["work", "update", "fiction", "--title", "Imported Work", "--brief", "Keep the author's manuscript"]);
    expect(updated.plan).toMatchObject({ serial: true, units: null, review: { enabled: false }, brief: "Keep the author's manuscript" });
    const revision = await runCli(root, ["import", "fiction", "--title", "Draft", "--content", "First paragraph.\n\nSecond paragraph.\n"]);
    const read = await runCli(root, ["artifact", "read", revision.artifactId]);
    expect(read.content).toBe("First paragraph.\n\nSecond paragraph.\n");
    await runCli(root, ["artifact", "edit", revision.artifactId, "--target-text", "Second", "--replacement", "Edited"]);
    expect((await runCli(root, ["artifact", "read", revision.artifactId])).content).toContain("Edited paragraph");
    expect((await runCli(root, ["artifact", "read", revision.artifactId, "--revision", revision.id])).content).toBe(read.content);
    const exported = await runCli(root, ["export", revision.artifactId, "--format", "md"]);
    expect(await readFile(join(root, exported.path), "utf8")).toContain("Edited paragraph");
  });

  it("keeps request IDs, domain pause, native abort, and completion receipts durable across CLI processes", async () => {
    await runCli(root, ["work", "create", "--id", "draft", "--title", "Imported draft", "--review", '{"enabled":false}']);
    await runCli(root, ["work", "pause", "draft"]);
    const args = ["write", "draft", "--content", "An explicit imported manuscript.", "--request-id", "same-content-request"];
    const first = await runCli(root, args), second = await runCli(root, args);
    expect(second).toEqual(first);
    expect((await runCli(root, ["tasks", "show", String(first.taskId)])).state.outcome).toBeUndefined();
    const paused = await runCli(root, ["tasks", "pause", String(first.taskId)]);
    expect(paused.pauseRequested).toBe(true);
    await runCli(root, ["goal", "cancel", String(first.taskId)]);
    const aborted = await runCli(root, ["tasks", "wait", String(first.taskId)], 1);
    expect(aborted.state.outcome.status).toBe("aborted");
    expect((await runCli(root, ["work", "show", "draft"])).pauseRequested).toBe(true);
    await runCli(root, ["work", "resume", "draft"]);
    const completed = await runCli(root, ["write", "draft", "--content", "A second explicitly imported manuscript.", "--request-id", "next-content-request", "--wait"]);
    expect(completed.task.state.outcome.status).toBe("completed");
    expect((await runCli(root, ["artifact", "read", completed.artifactId])).content).toContain("second explicitly imported");
  });

  it("deduplicates passive submissions and reopens the native conversation, without a client transcript", async () => {
    const conversation = await runCli(root, ["conversations", "create"]);
    const args = ["interact", "Saved without inference.", "--conversation", String(conversation.id), "--note", "--request-id", "same-note"];
    const first = await runCli(root, args), replay = await runCli(root, args);
    expect(replay.submission.id).toBe(first.submission.id);
    expect(first.submission.status).toBe("done");
    const reopened = await runCli(root, ["conversations", "show", String(conversation.id)]);
    expect(reopened.entries.filter((entry: any) => entry.kind === "inkos.note").map((entry: any) => entry.data.text)).toEqual(["Saved without inference."]);
    await expect(stat(join(root, ".inkos", "tui-session.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the fixed publishing target RPC and queues a future distribution without contacting a publisher", async () => {
    await runCli(root, ["work", "create", "--id", "publishable", "--title", "Publishable"]);
    const revision = await runCli(root, ["artifact", "save", "publishable", "--title", "Imported", "--content", "An imported draft."]);
    const target = await runCli(root, ["publishing", "create-target", "destination", "--work", "publishable", "--publisher", "browser", "--account-id", "author", "--account-label", "Author", "--metadata", '{"entryUrl":"https://example.invalid/"}']);
    expect(target.id).toBe("destination");
    expect((await runCli(root, ["publishing", "targets"])).map((item: any) => item.id)).toEqual([target.id]);
    const args = ["publishing", "queue", target.id, revision.artifactId, "--scheduled-at", String(Date.now() + 86_400_000), "--request-id", "future-distribution"];
    const distribution = await runCli(root, args), replay = await runCli(root, args);
    expect(replay.id).toBe(distribution.id);
    expect(replay.taskId).toBe(distribution.taskId);
    await runCli(root, ["tasks", "cancel", String(distribution.taskId)]);
    expect((await runCli(root, ["tasks", "wait", String(distribution.taskId)], 1)).state.outcome.status).toBe("aborted");
  });

  it("starts a CLI-owned Studio separately and down does not stop an unspecified project's runtime", async () => {
    const other = await tempProject();
    try {
      await runCli(other, ["init"]);
      const independent = await runCli(other, ["up", "--no-studio"]);
      const started = await runCli(root, ["up", "--port", "0", "--host", "127.0.0.1"]);
      expect(started.studio.pid).not.toBe(started.pid);
      expect((await fetch(started.studio.url)).ok).toBe(true);
      const stopped = await runCli(root, ["down"]);
      expect(stopped).toMatchObject({ runtimeStopped: true, studioStopped: true });
      await expect.poll(() => RuntimeClient.find(root)).toBeUndefined();
      await expect.poll(() => findStudio(root)).toBeUndefined();
      expect((await runCli(other, ["status"])).pid).toBe(independent.pid);
    } finally { await stopProject(other); }
  });
});
