import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveLLMConfig, type LLMConsumer } from "../utils/effective-llm-config.js";
import { loadProjectConfig } from "../utils/config-loader.js";
import { createLLMClient, chatCompletion } from "../llm/provider.js";
import { resolveCoverGenerationRequest } from "../pipeline/short-fiction-runner.js";
import { withRuntimeExecution } from "../runtime/execution.js";

const roots: string[] = [];
const codexClient = vi.hoisted(() => vi.fn(async () => { throw new Error("Codex fallback forbidden"); }));
vi.mock("../codex/client.js", () => ({ createCodexClient: codexClient }));
vi.mock("../runtime/auth/pi-native-store-compat.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("../runtime/auth/pi-native-store-compat.ts");
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function project(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "inkos-codex-config-")); roots.push(root);
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Codex only", version: "0.1.0", language: "en", ...extra }));
  return root;
}
async function emptyPiAgentDir() {
  const dir = await mkdtemp(join(tmpdir(), "inkos-pi-empty-agent-")); roots.push(dir);
  return dir;
}
const envLayers = { global: {}, project: {}, process: {} };

describe("capability-scoped Codex project configuration", () => {
  it.each<LLMConsumer>(["studio", "cli", "daemon", "deploy"])("loads a cold %s project with no provider, key, env, or services", async consumer => {
    const root = await project();
    const result = await resolveEffectiveLLMConfig({ consumer, projectRoot: root, envLayers, purpose: "codex" });
    expect(result.diagnostics.configMode).toBe("codex");
    expect(result.llm).toMatchObject({ service: "codex", model: "gpt-6.1-sol", apiKey: "" });
    const client = createLLMClient(result.llm, root);
    expect(client._codex?.projectRoot).toBe(root);
    expect(client._piModel).toBeUndefined();
    expect(client._apiKey).toBeUndefined();
    await expect(chatCompletion(client, result.llm.model, [{ role: "user", content: "Don't send" }])).rejects.toThrow("explicit provider configuration");
  });

  it("ignores stale provider model/endpoint/overrides and never loads secrets, while rereading Codex settings", async () => {
    const root = await project({ llm: { service: "google", provider: "custom", baseUrl: "", model: "outdated-gpt", services: [{ service: "google" }], defaultModel: "gpt-legacy" }, modelOverrides: { radar: { model: "legacy", baseUrl: "not-a-url" } } });
    const before = await readFile(join(root, "inkos.json"), "utf8");
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "secrets.json"), "this file must not be read");
    const resolve = () => resolveEffectiveLLMConfig({ consumer: "cli", projectRoot: root, purpose: "codex",
      envLayers: { ...envLayers, process: { INKOS_LLM_API_KEY: "not-for-codex", INKOS_LLM_MODEL: "bad", INKOS_LLM_TEMPERATURE: "bad", INKOS_LLM_BASE_URL: "bad" } }, cli: { service: "google", model: "legacy-not-in-google" } });
    await writeFile(join(root, ".inkos", "codex-config.json"), JSON.stringify({ model: "codex-first", reasoningEffort: "high", serviceTier: "fast" }));
    expect((await resolve()).llm.model).toBe("codex-first");
    await writeFile(join(root, ".inkos", "codex-config.json"), JSON.stringify({ model: "codex-second", reasoningEffort: "low", serviceTier: "default" }));
    const changed = await resolve();
    expect(changed.llm.model).toBe("codex-second");
    expect(changed.config.modelOverrides).toBeUndefined();
    expect(changed.llm.apiKey).toBe("");
    expect(await readFile(join(root, "inkos.json"), "utf8")).toBe(before);
  });

  it("retains non-provider CLI language overlays without applying them to Studio", async () => {
    const root = await project();
    const layers = { ...envLayers, process: { INKOS_DEFAULT_LANGUAGE: "zh" } };
    expect((await resolveEffectiveLLMConfig({ consumer: "cli", projectRoot: root, envLayers: layers, purpose: "codex" })).config.language).toBe("zh");
    expect((await resolveEffectiveLLMConfig({ consumer: "studio", projectRoot: root, envLayers: layers, purpose: "codex" })).config.language).toBe("en");
  });

  it("retains strict provider-key checks without consulting Codex login or silently falling back", async () => {
    const root = await project({ llm: { configSource: "studio", service: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1", provider: "openai" } });
    await expect(resolveEffectiveLLMConfig({ consumer: "studio", projectRoot: root, envLayers, purpose: "provider" })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
    await expect(loadProjectConfig(root, { consumer: "studio" })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });

  it("validates Codex settings and image settings without requiring obsolete text provider fields", async () => {
    const root = await project({ llm: { cover: { service: "openai", model: "gpt-image-2" } } });
    const config = await loadProjectConfig(root, { purpose: "codex" });
    expect(config.llm.cover).toEqual({ service: "openai", model: "gpt-image-2" });
    await expect(resolveCoverGenerationRequest({ root })).rejects.toThrow("Cover API key is required");
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({ services: { "cover:openai": { apiKey: "fixture-cover-key" } } }));
    await expect(resolveCoverGenerationRequest({ root })).resolves.toMatchObject({ apiKey: "fixture-cover-key", model: "gpt-image-2" });
    await writeFile(join(root, ".inkos", "codex-config.json"), '{"reasoningEffort":"made-up"}');
    await expect(loadProjectConfig(root, { purpose: "codex" })).rejects.toThrow("Cannot read Codex settings");
  });
});

it('projects a saved native model as unknown metadata without writing defaults or probing authentication', async () => {
  const root = await project();
  await mkdir(join(root, '.inkos'));
  const bytes = JSON.stringify({ model: null, reasoningEffort: 'medium', serviceTier: 'default' });
  await writeFile(join(root, '.inkos', 'codex-config.json'), bytes);
  const result = await resolveEffectiveLLMConfig({ consumer: 'studio', projectRoot: root, envLayers, purpose: 'codex' });
  expect(result.llm.model).toBe('codex-default');
  expect(await readFile(join(root, '.inkos', 'codex-config.json'), 'utf8')).toBe(bytes);
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(join(root, '.inkos'))).toEqual(['codex-config.json']);
});

it("projects a saved Pi intention without authenticating or persisting defaults", async () => {
  const root = await project();
  const projectConfigBytes = await readFile(join(root, "inkos.json"), "utf8");
  const agentDir = await emptyPiAgentDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  expect(getAgentDir()).toBe(agentDir);
  await mkdir(join(root, ".inkos"));
  const bytes = JSON.stringify({ schemaVersion: 1, revision: 9, selectedHarnessId: "pi", modelConnectionRef: null,
    harnessPreferences: { codex: { model: "gpt-6.1-sol", effort: "ultra", speed: "priority" }, pi: { model: null, effort: null, speed: null } } });
  await writeFile(join(root, ".inkos", "agent-config.json"), bytes);
  const projectEntries = await readdir(root);
  const settingsEntries = await readdir(join(root, ".inkos"));
  const result = await resolveEffectiveLLMConfig({ consumer: "studio", projectRoot: root, envLayers, purpose: "codex" });
  expect(result.llm).toMatchObject({ service: "pi", model: "pi-default", apiKey: "" });
  expect(result.diagnostics).toMatchObject({ configMode: "pi", modelSource: "agent-settings" });
  const runtimeResult = await resolveEffectiveLLMConfig({ consumer: "studio", projectRoot: root, envLayers, purpose: "runtime" });
  expect(runtimeResult.llm).toEqual(result.llm);
  const client = createLLMClient(result.llm, root);
  expect(client._runtime).toEqual({ projectRoot: root, harnessId: "pi" });
  expect(client._codex).toBeUndefined();
  expect(client._piModel).toBeUndefined();
  expect(client._apiKey).toBeUndefined();
  await expect(chatCompletion(client, result.llm.model, [{ role: "user", content: "Do not send" }]))
    .rejects.toThrow("explicit provider configuration");
  expect(await readFile(join(root, ".inkos", "agent-config.json"), "utf8")).toBe(bytes);
  expect(await readFile(join(root, "inkos.json"), "utf8")).toBe(projectConfigBytes);
  expect(await readdir(root)).toEqual(projectEntries);
  expect(await readdir(join(root, ".inkos"))).toEqual(settingsEntries);
  expect(await readdir(agentDir)).toEqual([]);
});

it("rejects a real unauthenticated Pi run before work or Codex/network fallback", async () => {
  const root = await project();
  const projectConfigBytes = await readFile(join(root, "inkos.json"), "utf8");
  const agentDir = await emptyPiAgentDir();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  expect(getAgentDir()).toBe(agentDir);
  await mkdir(join(root, ".inkos"));
  const bytes = JSON.stringify({ schemaVersion: 1, revision: 9, selectedHarnessId: "pi", modelConnectionRef: null,
    harnessPreferences: { codex: { model: "gpt-6.1-sol", effort: "ultra", speed: "priority" }, pi: { model: null, effort: null, speed: null } } });
  const settingsPath = join(root, ".inkos", "agent-config.json");
  await writeFile(settingsPath, bytes);
  const projectEntries = await readdir(root);
  const settingsEntries = await readdir(join(root, ".inkos"));
  const agentEntries = await readdir(agentDir);
  const fetchSentinel = vi.fn(() => { throw new Error("Network forbidden"); });
  vi.stubGlobal("fetch", fetchSentinel);
  codexClient.mockClear();
  const bodySpy = vi.fn(async () => undefined);

  await expect(withRuntimeExecution(root, bodySpy)).rejects.toMatchObject({
    code: "RUNTIME_AUTH_REVOKED", message: "Pi requires an existing ChatGPT OAuth credential",
  });
  expect(bodySpy).not.toHaveBeenCalled();
  expect(codexClient).not.toHaveBeenCalled();
  expect(fetchSentinel).not.toHaveBeenCalled();
  expect(await readFile(settingsPath, "utf8")).toBe(bytes);
  expect(await readFile(join(root, "inkos.json"), "utf8")).toBe(projectConfigBytes);
  expect(await readdir(root)).toEqual(projectEntries);
  expect(await readdir(join(root, ".inkos"))).toEqual(settingsEntries);
  expect(await readdir(agentDir)).toEqual(agentEntries);
  expect(agentEntries).not.toContain("inkos-connection.json");
  expect(agentEntries).not.toContain("auth.json");
});
