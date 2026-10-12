import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureProjectDirectoryInitialized, initializeProjectDirectory } from "../project-bootstrap.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "inkos-bootstrap-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("project bootstrap", () => {
  it("creates a minimal project without a runtime, model config, or credential owner", async () => {
    expect(await ensureProjectDirectoryInitialized(root, { language: "en" })).toBe(true);
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf8"));
    expect(config).toEqual({ name: root.split("/").at(-1), version: "2.0.0", language: "en" });
    expect(await readdir(join(root, ".inkos"))).toEqual([]);
    expect(await readdir(join(root, "works"))).toEqual([]);
  });
  it("preserves existing support files and appends project-local runtime ignores", async () => {
    await writeFile(join(root, ".env"), "EXISTING=1\n");
    await writeFile(join(root, ".gitignore"), "dist/\n# keep me\n");
    await initializeProjectDirectory(root);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("EXISTING=1\n");
    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain("dist/\n# keep me\n");
    for (const entry of [".env", "node_modules/", ".DS_Store", ".inkos/", ".inkos-runtime-start.log"]) expect(ignored).toContain(`${entry}\n`);
  });
  it("never overwrites an initialized project", async () => {
    await writeFile(join(root, "inkos.json"), "{}\n");
    expect(await ensureProjectDirectoryInitialized(root)).toBe(false);
    await expect(initializeProjectDirectory(root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, "inkos.json"), "utf8")).toBe("{}\n");
  });
});
