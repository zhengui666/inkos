import { mkdtemp, readFile, writeFile, rm, access, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
// Vitest 3 SSR omits import.meta.resolve. Node 22 loads the actual module unchanged.
const { createPiNativeStoreCompat, loadPiNativeAuthStorage, validatePiNativeAuthStorage, inspectPiSdkInstallation, validatePiSdkDependency } =
  createRequire(import.meta.url)("../pi-native-store-compat.ts") as typeof import("../pi-native-store-compat.js");

const oauth = (access = "fake-access") => ({ type: "oauth" as const, access, refresh: "fake-refresh", expires: Date.now() + 3_600_000 });
const dirs: string[] = [];
async function fixture(value?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "inkos-pi-auth-")); dirs.push(dir);
  const path = join(dir, "auth.json");
  if (value !== undefined) await writeFile(path, JSON.stringify(value, null, 2));
  return { dir, path, store: await createPiNativeStoreCompat(path) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); vi.restoreAllMocks(); });

describe("Pi 1.1.0 native auth storage temporary fixture contract", () => {
  it("loads the installed actual internal module and validates its API", async () => {
    const native = await loadPiNativeAuthStorage();
    expect(typeof native.AuthStorage.create).toBe("function");
    for (const method of ["modify", "delete", "list"] as const) expect(typeof native.AuthStorage.prototype[method]).toBe("function");
  });
  it("resolves exact related protocol modules from the actual coding-agent root", async () => {
    const modules = await inspectPiSdkInstallation();
    expect(modules.map(module => [module.name, module.version])).toEqual([
      ["@earendil-works/pi-coding-agent", "1.1.0"], ["@earendil-works/pi-ai", "1.1.0"],
      ["@earendil-works/pi-agent-core", "1.1.0"], ["@earendil-works/pi-tui", "1.1.0"],
      ["@earendil-works/pi-ai", "1.1.0"],
    ]);
    expect(modules.every(module => module.entry === join(module.root, "dist", "index.js"))).toBe(true);
    expect(modules[4].importer).toBe("@earendil-works/pi-agent-core");
    expect(modules[4].entry).toBe(modules[1].entry);
  });
  it.each(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"])("rejects unsupported related version or missing protocol API for %s", name => {
    expect(() => validatePiSdkDependency(name, { name, version: "1.2.0" }, {})).toThrow("1.1.0");
    expect(() => validatePiSdkDependency(name, { name, version: "1.1.0" }, {})).toThrow("protocol API");
  });
  it.each(["1.1.1", "1.0.0"])("fails closed on unsupported version %s", async version => {
    const native = await loadPiNativeAuthStorage();
    expect(() => validatePiNativeAuthStorage({ name: "@earendil-works/pi-coding-agent", version }, "1.1.0", native)).toThrow("1.1.0");
    expect(() => validatePiNativeAuthStorage({ name: "@earendil-works/pi-coding-agent", version: "1.1.0" }, version, native)).toThrow("1.1.0");
  });
  it("fails closed on a different package or missing native methods", () => {
    expect(() => validatePiNativeAuthStorage({ name: "other", version: "1.1.0" }, "1.1.0", {})).toThrow("1.1.0");
    expect(() => validatePiNativeAuthStorage({ name: "@earendil-works/pi-coding-agent", version: "1.1.0" }, "1.1.0", { AuthStorage: { create() {}, prototype: {} } })).toThrow("storage API");
  });
  it("reads under native modify without changing OAuth file bytes", async () => {
    const { path, store } = await fixture({ openai: oauth(), other: { type: "api_key", key: "untouched" } });
    const before = await readFile(path, "utf8");
    expect(await store.read("openai")).toEqual(JSON.parse(before).openai);
    expect(await store.list()).toEqual([{ providerId: "openai", type: "oauth" }]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.read("other")).toBeUndefined();
  });
  it("does not create missing auth files on reads or lists", async () => {
    const { path, store } = await fixture();
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects api_key before its bang command can execute", async () => {
    const { dir, path, store } = await fixture({ openai: { type: "api_key", key: "placeholder" } });
    const marker = join(dir, "command-must-not-run");
    await writeFile(path, JSON.stringify({ openai: { type: "api_key", key: `!touch ${marker}` } }));
    await expect(store.read("openai")).rejects.toThrow("OAuth");
    await expect(store.list()).rejects.toThrow("OAuth");
    await expect(store.modify("openai", async () => oauth())).rejects.toThrow("OAuth");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([null, [], {}, { type: "oauth", access: "fake", refresh: "fake", expires: "invalid" }])("rejects malformed raw credential %j", async current => {
    const { store } = await fixture({ openai: current });
    await expect(store.read("openai")).rejects.toThrow("OAuth");
  });
  it("serializes concurrent fake refreshes using the actual file lock", async () => {
    const { path, store } = await fixture({ openai: oauth("old"), other: { type: "api_key", key: "untouched" } });
    const second = await createPiNativeStoreCompat(path); let refreshes = 0;
    const refresh = async (current: Awaited<ReturnType<typeof store.read>>) => {
      if (current?.type === "oauth" && current.access === "old") { refreshes++; await new Promise(resolve => setTimeout(resolve, 15)); return oauth("rotated"); }
      return undefined;
    };
    await Promise.all([store.modify("openai", refresh), second.modify("openai", refresh)]);
    expect(refreshes).toBe(1); expect(await second.read("openai")).toMatchObject({ type: "oauth", access: "rotated" });
    expect(JSON.parse(await readFile(path, "utf8")).other.key).toBe("untouched");
    await second.delete("openai"); expect(await store.list()).toEqual([]);
  });
  it("rejects non-openai mutations and new api_key values without writing", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const before = await readFile(path, "utf8");
    await expect(store.modify("other", async () => oauth())).rejects.toThrow("openai");
    await expect(store.delete("other")).rejects.toThrow("openai");
    await expect(store.modify("openai", async () => ({ type: "api_key", key: "fake" }))).rejects.toThrow("OAuth");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("also rejects an unexpected api_key from the native modify final result", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const before = await readFile(path, "utf8");
    const { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
    vi.spyOn(AuthStorage.prototype, "modify").mockImplementation(async function (this: typeof AuthStorage.prototype, provider, fn, options) {
      await original.call(this, provider, fn, options); return { type: "api_key", key: "fake-final-result" };
    });
    await expect(store.modify("openai", async () => undefined)).rejects.toThrow("OAuth");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("propagates native persistence failure without claiming a successful refresh", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const saved = `${path}.saved`;
    const before = await readFile(path, "utf8");
    await expect(store.modify("openai", async () => {
      await rename(path, saved); await mkdir(path); return oauth("rotated");
    })).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readFile(saved, "utf8")).toBe(before);
  });
});
