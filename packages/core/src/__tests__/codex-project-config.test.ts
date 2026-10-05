import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveLLMConfig, type LLMConsumer } from "../utils/effective-llm-config.js";
import { loadProjectConfig } from "../utils/config-loader.js";
import { createLLMClient, chatCompletion } from "../llm/provider.js";
import { resolveCoverGenerationRequest } from "../pipeline/short-fiction-runner.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "inkos-codex-config-")); roots.push(root);
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Codex only", version: "0.1.0", language: "en", ...extra }));
  return root;
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
