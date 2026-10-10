import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
import { VERSION, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

export type PiCredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<PiCredentialStore["read"]>>>;
type NativeModule = { AuthStorage: { create(path: string): PiCredentialStore; prototype: PiCredentialStore } };
const packageName = "@earendil-works/pi-coding-agent", version = "1.1.0";
export interface PiSdkModuleResolution { readonly name: string; readonly version: string; readonly root: string; readonly entry: string; readonly importer?: string }

/** Related protocol APIs are supported only at the audited 1.1.0 baseline. */
export function validatePiSdkDependency(name: string, manifest: unknown, module: unknown): void {
  const pkg = manifest as { name?: unknown; version?: unknown } | null;
  const api = module as Record<string, unknown> | null;
  if (!["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"].includes(name) ||
      pkg?.name !== name || pkg.version !== version || !api) throw new Error("Pi SDK dependency compatibility requires version 1.1.0");
  if (name === "@earendil-works/pi-ai" && ["createModels", "lazyStream", "ModelsError"].some(key => typeof api[key] !== "function")) {
    throw new Error("Pi SDK dependency protocol API is unsupported");
  }
  if (name === "@earendil-works/pi-agent-core") {
    const agent = api.Agent;
    if (typeof agent !== "function" || ["subscribe", "continue", "abort", "waitForIdle"].some(key => typeof (agent as { prototype?: Record<string, unknown> }).prototype?.[key] !== "function")) {
      throw new Error("Pi SDK dependency protocol API is unsupported");
    }
  }
  if (name === "@earendil-works/pi-tui" && ["Container", "Text"].some(key => typeof api[key] !== "function")) {
    throw new Error("Pi SDK dependency protocol API is unsupported");
  }
}

/** Inspect only the known runtime edges, resolving each from its actual importer. */
export async function inspectPiSdkInstallation(): Promise<readonly PiSdkModuleResolution[]> {
  try {
  const entry = await realpath(fileURLToPath(import.meta.resolve(packageName)));
  const root = await realpath(dirname(dirname(entry)));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
  validatePackage(manifest, VERSION);
  if (entry !== join(root, "dist", "index.js")) throw new Error("Pi SDK root layout is unsupported");
  const resolved: PiSdkModuleResolution[] = [{ name: packageName, version, root, entry }];
  async function dependency(name: string, importer: string, importerEntry: string): Promise<PiSdkModuleResolution> {
    const json = findPackageJSON(name, pathToFileURL(importerEntry));
    if (!json) throw new Error("Pi SDK related dependency could not be resolved");
    const dependencyRoot = await realpath(dirname(json));
    const pkg = JSON.parse(await readFile(json, "utf8")) as { name: string; version: string; exports?: { "."?: { import?: string } }; main?: string };
    if (pkg.name !== name || pkg.version !== version) throw new Error("Pi SDK dependency compatibility requires version 1.1.0");
    const target = pkg.exports?.["."]?.import ?? pkg.main;
    if (target !== "./dist/index.js" && target !== "dist/index.js") throw new Error("Pi SDK dependency entry layout is unsupported");
    const dependencyEntry = await realpath(join(dependencyRoot, target));
    if (dependencyEntry !== join(dependencyRoot, "dist", "index.js")) throw new Error("Pi SDK dependency escaped its package boundary");
    validatePiSdkDependency(name, pkg, await import(pathToFileURL(dependencyEntry).href));
    return { name, version: pkg.version, root: dependencyRoot, entry: dependencyEntry, importer };
  }
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"]) {
    resolved.push(await dependency(name, packageName, entry));
  }
  const agentCore = resolved.find(module => module.name === "@earendil-works/pi-agent-core")!;
  // A nested/caret pi-ai install used by Agent may differ from coding-agent's own resolution.
  resolved.push(await dependency("@earendil-works/pi-ai", agentCore.name, agentCore.entry));
  return Object.freeze(resolved.map(module => Object.freeze(module)));
  } catch { throw new Error("Pi SDK dependency compatibility requires supported 1.1.0 modules and APIs"); }
}

function validatePackage(manifest: unknown, sdkVersion: string): void {
  const pkg = manifest as { name?: unknown; version?: unknown } | null;
  if (pkg?.name !== packageName || pkg.version !== version || sdkVersion !== version) {
    throw new Error("Pi native auth compatibility requires the official 1.1.0 storage API");
  }
}

/** Internal SDK compatibility contract; never substitutes a local storage implementation. */
export function validatePiNativeAuthStorage(manifest: unknown, sdkVersion: string, module: unknown): NativeModule {
  validatePackage(manifest, sdkVersion);
  const native = module as NativeModule | null;
  if (typeof native?.AuthStorage?.create !== "function" ||
      ["modify", "delete", "list"].some(method => typeof native.AuthStorage.prototype?.[method as keyof PiCredentialStore] !== "function")) {
    throw new Error("Pi native auth compatibility requires the official 1.1.0 storage API");
  }
  return native;
}

export async function loadPiNativeAuthStorage(): Promise<NativeModule> {
  // The public root is resolved first; the non-exported module must belong to that exact install.
  const [{ root }] = await inspectPiSdkInstallation();
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
  validatePackage(manifest, VERSION);
  const internal = await realpath(join(root, "dist", "core", "auth-storage.js"));
  const boundary = relative(root, internal);
  if (isAbsolute(boundary) || boundary === ".." || boundary.startsWith("../") || boundary.startsWith("..\\")) {
    throw new Error("Pi native auth module escaped its package boundary");
  }
  return validatePiNativeAuthStorage(manifest, VERSION, await import(pathToFileURL(internal).href));
}

function oauthOnly(value: unknown): Credential | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Pi requires a valid ChatGPT OAuth credential");
  const raw = value as Record<string, unknown>;
  if (raw.type !== "oauth" || typeof raw.access !== "string" || !raw.access ||
      typeof raw.refresh !== "string" || !raw.refresh || typeof raw.expires !== "number" || !Number.isFinite(raw.expires)) {
    throw new Error("Pi requires a valid ChatGPT OAuth credential");
  }
  return structuredClone(value) as Credential;
}
function requireOpenAI(provider: string): void {
  if (provider !== "openai") throw new Error("Pi credential mutations are restricted to openai OAuth");
}

/** Explicit path only. Native locks and writes remain entirely owned by Pi. */
export async function createPiNativeStoreCompat(authPath: string): Promise<PiCredentialStore> {
  if (!isAbsolute(authPath)) throw new Error("Pi auth storage requires an explicit absolute path");
  const { AuthStorage } = await loadPiNativeAuthStorage();
  // Missing-at-read files are untouched. Pi itself may recreate {} after an external
  // unlink between this check and its native lock; the SDK offers no atomic no-create read.
  async function native(create: boolean): Promise<PiCredentialStore | undefined> {
    if (!create) {
      try { await access(authPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }
    return AuthStorage.create(authPath);
  }
  const store: PiCredentialStore = {
    async read(provider, options) {
      options?.signal?.throwIfAborted(); if (provider !== "openai") return undefined;
      const storage = await native(false); if (!storage) return undefined;
      let credential: Credential | undefined;
      await storage.modify(provider, async raw => { credential = oauthOnly(raw); return undefined; }, options);
      return credential;
    },
    async list(options) { return (await store.read("openai", options)) ? [{ providerId: "openai", type: "oauth" }] : []; },
    async modify(provider, fn, options) {
      requireOpenAI(provider); options?.signal?.throwIfAborted();
      const storage = (await native(true))!;
      return oauthOnly(await storage.modify(provider, async raw => oauthOnly(await fn(oauthOnly(raw))), options));
    },
    async delete(provider, options) {
      requireOpenAI(provider); options?.signal?.throwIfAborted();
      const storage = await native(false); if (storage) await storage.delete(provider, options);
    },
  };
  return store;
}
