import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  log: vi.fn(), readFile: vi.fn(), chat: vi.fn(), createClient: vi.fn(),
  fetch: vi.fn(), createAccount: vi.fn(), readiness: vi.fn(), dispose: vi.fn(), parseConfig: vi.fn(),
}));
const llm = { provider: "openai", model: "fixture-model", baseUrl: "http://127.0.0.1:1", apiKey: "", apiFormat: "chat", stream: false };
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../utils.js", () => ({
  findProjectRoot: () => "/controlled/doctor-fixture", GLOBAL_ENV_PATH: "/controlled/empty-env",
  log: mocks.log, logError: vi.fn(), loadConfig: async () => ({ llm }),
  loadConfigWithDiagnostics: async () => ({ llm, diagnostics: {
    configMode: "fixture", serviceSource: "fixture", modelSource: "fixture", apiKeySource: "none", warnings: [],
  } }),
}));
vi.mock("../runtime-requirements.js", () => ({
  evaluateNodeRuntimeSupport: () => ({ ok: true, detail: "fixture" }),
  inspectNodeRuntimePinFiles: async () => ({ ok: true, detail: "fixture" }),
  ensureNodeRuntimePinFiles: vi.fn(),
}));
vi.mock("@actalk/inkos-core", () => ({
  fetchWithProxy: mocks.fetch, chatCompletion: mocks.chat, createLLMClient: mocks.createClient,
  LLMConfigSchema: { parse: mocks.parseConfig },
  isApiKeyOptionalForEndpoint: () => true, resolveServiceModelsBaseUrl: () => undefined,
  StateManager: class { async listBooks() { return []; } },
  createCodexAccountService: mocks.createAccount, inspectCodexReadiness: mocks.readiness,
}));
import { buildDoctorModelCandidates, doctorCommand, resolveDoctorModelsBaseUrl } from "../commands/doctor.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue("{}");
  mocks.createClient.mockReturnValue({});
  mocks.createAccount.mockReturnValue({ dispose: mocks.dispose });
  mocks.readiness.mockResolvedValue({ model: "fixture", reasoningEffort: "medium", serviceTier: "default" });
  mocks.dispose.mockResolvedValue(undefined);
  mocks.fetch.mockRejectedValue(new Error("Network is forbidden in this fixture"));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("doctor model candidate probing", () => {
  it("keeps the configured model first, then tries discovered models without duplicates", () => {
    const candidates = buildDoctorModelCandidates("google/gemma-4-26b-4b", [
      { id: "google/gemma-4-26b-4b", name: "google/gemma-4-26b-4b" },
      { id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" },
      { id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);

    expect(candidates[0]).toBe("google/gemma-4-26b-4b");
    expect(candidates[1]).toBe("google/gemma-4-27b-it");
    expect(candidates[2]).toBe("gemini-2.5-flash");
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("falls back to common compatibility candidates when /models is unavailable", () => {
    const candidates = buildDoctorModelCandidates("missing-model", []);
    expect(candidates[0]).toBe("missing-model");
    expect(candidates).toContain("gpt-5.4");
    expect(candidates).toContain("MiniMax-M2.7");
    expect(candidates).toContain("gemini-2.5-flash");
  });

  it("uses the service-specific models endpoint when the preset defines one", () => {
    const modelsBaseUrl = resolveDoctorModelsBaseUrl(
      "bailian",
      "https://dashscope.aliyuncs.com/apps/anthropic",
      (service) => service === "bailian" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : undefined,
    );

    expect(modelsBaseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

});

describe("doctor successful provider usage display", () => {
  it.each([
    { usage: undefined, display: "unavailable" },
    { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, display: "0" },
    { usage: { promptTokens: 10, completionTokens: 7, totalTokens: 17 }, display: "17" },
  ])("keeps connectivity successful with tokens=$display and one probe", async ({ usage, display }) => {
    mocks.chat.mockResolvedValue({ content: "OK", usage });
    await doctorCommand.parseAsync(["--provider"], { from: "user" });
    const output = mocks.log.mock.calls.map(call => call[0]).join("\n");
    expect(output).toContain(`[OK] API Connectivity: OK (model: fixture-model, apiFormat=chat, stream=false, tokens: ${display})`);
    expect(mocks.chat).toHaveBeenCalledOnce();
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.parseConfig).not.toHaveBeenCalled();
    expect(mocks.createAccount).toHaveBeenCalledOnce();
    expect(mocks.readiness).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
