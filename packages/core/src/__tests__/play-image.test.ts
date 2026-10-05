import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPlayImageManifest,
  findPlaySceneImageKey,
  buildPlaySceneImagePrompt,
  setPlayImageEntry,
  playImageFileName,
  readPlayImageSettings,
  writePlayImageSettings,
  DEFAULT_PLAY_IMAGE_SETTINGS,
} from "../play/play-image.js";

describe("play image manifest", () => {
  let runDir: string;
  beforeEach(async () => { runDir = await mkdtemp(join(tmpdir(), "inkos-playimg-")); });
  afterEach(async () => { await rm(runDir, { recursive: true, force: true }); });

  it("returns {} for a run with no manifest yet", async () => {
    expect(await readPlayImageManifest(runDir)).toEqual({});
  });

  it("reuses old scene keys from saved prompt bytes and distinguishes changed scenes", async () => {
    const key = "scene-turn-2-legacy-recorded-key";
    const prompt = buildPlaySceneImagePrompt("The door is closed.", "Workshop");
    await setPlayImageEntry(runDir, key, {status: "ready", file: "old-image.png"});
    await writeFile(join(runDir, "images", key + ".source.md"), "Original skill guidance\n\n" + prompt);
    expect(await findPlaySceneImageKey(runDir, 2, "The door is closed.", "Workshop")).toBe(key);
    expect(await findPlaySceneImageKey(runDir, 2, "The door is open.", "Workshop")).toBeUndefined();
    expect((await readPlayImageManifest(runDir))[key]?.file).toBe("old-image.png");
  });

  it("finds ordinary new keys by the stored scene prompt without sidecars", async () => {
    const key = "scene-turn-3-saved-id";
    await setPlayImageEntry(runDir, key, {status: "ready", file: "saved-image.png", scenePrompt: buildPlaySceneImagePrompt("An empty room.")});
    expect(await findPlaySceneImageKey(runDir, 3, "An empty room.")).toBe(key);
    expect(await findPlaySceneImageKey(runDir, 3, "A crowded room.")).toBeUndefined();
  });

  it("round-trips an entry and merges without dropping existing keys", async () => {
    await setPlayImageEntry(runDir, "actor-1", { status: "ready", file: "actor-1.png" });
    await setPlayImageEntry(runDir, "item-2", { status: "failed", error: "503" });
    const manifest = await readPlayImageManifest(runDir);
    expect(manifest["actor-1"]).toEqual({ status: "ready", file: "actor-1.png" });
    expect(manifest["item-2"]).toEqual({ status: "failed", error: "503" });
    // persisted to disk as JSON
    const raw = JSON.parse(await readFile(join(runDir, "images", "manifest.json"), "utf-8"));
    expect(Object.keys(raw)).toHaveLength(2);
  });
});

describe("play image settings", () => {
  let runDir: string;
  beforeEach(async () => { runDir = await mkdtemp(join(tmpdir(), "inkos-playset-")); });
  afterEach(async () => { await rm(runDir, { recursive: true, force: true }); });

  it("defaults to all-off when no settings file exists", async () => {
    expect(await readPlayImageSettings(runDir)).toEqual(DEFAULT_PLAY_IMAGE_SETTINGS);
    expect(DEFAULT_PLAY_IMAGE_SETTINGS).toEqual({ actors: false, moments: false, inventory: false });
  });

  it("round-trips toggles and coerces to booleans", async () => {
    await writePlayImageSettings(runDir, { actors: true, moments: false, inventory: true });
    expect(await readPlayImageSettings(runDir)).toEqual({ actors: true, moments: false, inventory: true });
  });
});

describe("playImageFileName", () => {
  it("sanitizes ids into safe leaf names with the right extension", () => {
    expect(playImageFileName("actor-1", "png")).toBe("actor-1.png");
    expect(playImageFileName("scene/turn:3 评论", "jpg")).toBe("scene_turn_3___.jpg");
  });

  it("never produces an empty name", () => {
    expect(playImageFileName("！！！", "png")).toBe("___.png");
  });
});
