import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshotAtChapter } from "../state/runtime-state-store.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

it("settles every checkpoint file read before reporting the original first read failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-checkpoint-drain-"));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { entered = resolve; });
  let closed = false, settled = false;
  let loading: Promise<unknown> | undefined;
  try {
    await createInitialRuntimeState({ bookDir: root, language: "en" });
    await new StateManager(root).snapshotStateAt(root, 0);
    await writeFile(join(root, "story/snapshots/0/state/manifest.json"), "{broken first file");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (typeof path === "string" && path.endsWith("manifest.json")) {
        const handle = await open(path, "r"); entered();
        try { await gate; return await handle.readFile(options); }
        finally { await handle.close(); closed = true; }
      }
      if (String(path).endsWith("hooks.json")) throw new Error("later file failed first");
      return actual.readFile(path, options);
    });
    loading = loadRuntimeStateSnapshotAtChapter({ bookDir: root, chapterNumber: 0, language: "en" });
    void loading.then(() => { settled = true; }, () => { settled = true; });
    await opened;
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(closed).toBe(false);
    release();
    await expect(loading).rejects.toThrow("later file failed first");
    expect(closed).toBe(true);
    await rm(root, { recursive: true });
  } finally {
    release(); await loading?.catch(() => undefined); vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockImplementation(actual.readFile);
    await rm(root, { recursive: true, force: true });
  }
});
