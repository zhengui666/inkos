import { mkdtemp, readFile, writeFile, rm, access, rename, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionFailureFacts } from "../../../harness/action-observation.js";
const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const nodeModule = require("node:module") as typeof import("node:module");
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
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

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
  it("rejects a same-version nested pi-ai copy in the actual importer resolution path", async () => {
    const modules = await inspectPiSdkInstallation(), core = modules.find(module => module.name.endsWith("pi-agent-core"))!;
    const dir = await mkdtemp(join(tmpdir(), "inkos-pi-nested-")); dirs.push(dir);
    const nested = join(dir, "pi-agent-core", "node_modules", "@earendil-works", "pi-ai");
    await mkdir(join(nested, "dist"), { recursive: true });
    const manifest = join(nested, "package.json");
    await writeFile(manifest, JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.1.0", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
    // Delegate to the actual SDK APIs; only the package's real entry identity differs.
    await writeFile(join(nested, "dist", "index.js"), `export * from ${JSON.stringify(pathToFileURL(modules[1].entry).href)};\n`);
    const find = nodeModule.findPackageJSON;
    vi.spyOn(nodeModule, "findPackageJSON").mockImplementation((name, base) =>
      name === "@earendil-works/pi-ai" && String(base) === pathToFileURL(core.entry).href ? manifest : find(name, base));
    syncBuiltinESMExports();
    await expect(inspectPiSdkInstallation()).rejects.toThrow("one shared pi-ai");
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
  it("uses public raw reads without native storage creation, locks or changing file bytes", async () => {
    const { path, store } = await fixture({ openai: oauth(), other: { type: "api_key", key: "untouched" } });
    const { AuthStorage } = await loadPiNativeAuthStorage();
    const create = vi.spyOn(AuthStorage, "create"), modify = vi.spyOn(AuthStorage.prototype, "modify");
    const before = await readFile(path, "utf8");
    expect(await store.read("openai")).toEqual(JSON.parse(before).openai);
    expect(await store.list()).toEqual([{ providerId: "openai", type: "oauth" }]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.read("other")).toBeUndefined();
    expect(create).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled();
  });
  it("does not create missing auth files on reads or lists", async () => {
    const { path, store } = await fixture();
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not recreate auth after a deterministic unlink at the actual raw read", async () => {
    const { dir, path, store } = await fixture({ openai: oauth() });
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === path) fs.rmSync(path, { force: true });
      return read(file, options);
    });
    syncBuiltinESMExports();
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
  it("does not create absent parent directories on reads or lists", async () => {
    const { dir } = await fixture(); const path = join(dir, "missing-parent", "nested", "auth.json");
    const store = await createPiNativeStoreCompat(path);
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
  it("rereads replacements and treats corrupt JSON or a directory as unavailable without writes", async () => {
    const { dir, path, store } = await fixture({ openai: oauth("old") });
    expect(await store.read("openai")).toMatchObject({ access: "old" });
    const replacement = join(dir, "replacement.json");
    await writeFile(replacement, JSON.stringify({ openai: oauth("replacement") })); await rename(replacement, path);
    expect(await store.read("openai")).toMatchObject({ access: "replacement" });
    await writeFile(path, "{corrupt-sensitive-sentinel");
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("{corrupt-sensitive-sentinel");
    await rm(path); await mkdir(path);
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect(await readdir(path)).toEqual([]);
  });
  it("treats a raw permission failure as unavailable without exposing sensitive causes", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const before = await readFile(path, "utf8");
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === path) throw Object.assign(new Error("sensitive-permission-sentinel", { cause: { recovery: "sensitive-cause-sentinel" } }), { code: "EACCES" });
      return read(file, options);
    });
    syncBuiltinESMExports();
    expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(before);
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
  it("rejects replacement API keys and env credentials without resolving them", async () => {
    const { path, store } = await fixture({ openai: oauth() });
    vi.stubEnv("PI_AUTH_SENTINEL", "sensitive-env-sentinel");
    for (const credential of [{ type: "api_key", key: "sensitive-api-key-sentinel" }, { type: "api_key", key: "$PI_AUTH_SENTINEL", env: "PI_AUTH_SENTINEL" }]) {
      await writeFile(path, JSON.stringify({ openai: credential })); const before = await readFile(path, "utf8");
      const error = await store.read("openai").catch(error => error);
      expect(JSON.stringify(actionFailureFacts(error))).not.toContain("sentinel");
      await expect(store.list()).rejects.toThrow("OAuth"); expect(await readFile(path, "utf8")).toBe(before);
    }
  });
  it("cancels before read/list/mutation without exposing an abort reason or creating paths", async () => {
    const { dir } = await fixture(); const path = join(dir, "missing", "auth.json"), store = await createPiNativeStoreCompat(path);
    const controller = new AbortController(); controller.abort(new Error("sensitive-abort-sentinel", { cause: { recovery: "sensitive-cause-sentinel" } }));
    const options = { signal: controller.signal }, update = vi.fn(async () => oauth());
    for (const pending of [store.read("openai", options), store.list(options), store.modify("openai", update, options), store.delete("openai", options)]) {
      const error = await pending.catch(error => error); expect(error.name).toBe("AbortError");
      expect(JSON.stringify(actionFailureFacts(error))).not.toContain("sentinel"); expect(error.cause).toBeUndefined();
    }
    expect(update).not.toHaveBeenCalled(); expect(await readdir(dir)).toEqual([]);
  });
  it("cancels during the raw read without returning a credential or leaking the reason", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const controller = new AbortController(), read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file) === path) controller.abort(new Error("sensitive-read-abort-sentinel"));
      return read(file, options);
    });
    syncBuiltinESMExports();
    const error = await store.read("openai", { signal: controller.signal }).catch(error => error);
    expect(error.name).toBe("AbortError"); expect(JSON.stringify(actionFailureFacts(error))).not.toContain("sentinel");
  });
  it("cancels under the native mutation lock before persistence and releases the lock", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const before = await readFile(path, "utf8"), controller = new AbortController();
    const error = await store.modify("openai", async () => { controller.abort(new Error("sensitive-mutation-abort-sentinel")); return oauth("not-committed"); }, { signal: controller.signal }).catch(error => error);
    expect(error.name).toBe("AbortError"); expect(JSON.stringify(actionFailureFacts(error))).not.toContain("sentinel");
    expect(await readFile(path, "utf8")).toBe(before);
    await store.modify("openai", async () => oauth("next")); expect(await store.read("openai")).toMatchObject({ access: "next" });
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
  it("strips arbitrary mutation error messages and cause metadata before host serialization", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const before = await readFile(path, "utf8");
    const failure = new Error("sensitive-message-sentinel", { cause: { code: "sensitive-code-sentinel", recovery: { token: "sensitive-recovery-sentinel" } } });
    const error = await store.modify("openai", async () => { throw failure; }).catch(error => error);
    expect(error.message).toContain("mutation failed"); expect(error.cause).toBeUndefined();
    expect(JSON.stringify(actionFailureFacts(error))).not.toContain("sentinel"); expect(await readFile(path, "utf8")).toBe(before);
  });
  it("propagates native persistence failure without claiming a successful refresh", async () => {
    const { path, store } = await fixture({ openai: oauth() }); const saved = `${path}.saved`;
    const before = await readFile(path, "utf8");
    await expect(store.modify("openai", async () => {
      await rename(path, saved); await mkdir(path); return oauth("rotated");
    })).rejects.toThrow("mutation failed");
    expect(await readFile(saved, "utf8")).toBe(before);
  });
});
