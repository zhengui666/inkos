import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountService } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";
import type { StudioCodexAccount } from "../shared/codex.js";

function mockService() {
  let state: StudioCodexAccount = { connected: false, account: null, requiresOpenaiAuth: true, login: null };
  let settings = { model: "codex-test", reasoningEffort: "medium", serviceTier: "default" };
  const login = { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "CODE-1234" };
  return {
    readAccount: vi.fn(async () => state),
    startDeviceLogin: vi.fn(async () => { state = { ...state, login: { ...login, status: "pending" } }; return login; }),
    cancelLogin: vi.fn(async () => { state = { ...state, login: state.login ? { ...state.login, status: "cancelled" } : null }; }),
    logout: vi.fn(async () => { state = { connected: false, account: null, requiresOpenaiAuth: true, login: null }; }),
    readSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => { settings = { ...settings, ...patch }; return settings; }),
    listModels: vi.fn(async () => [{ id: "codex-test", model: "codex-test", displayName: "Codex Test", description: "", isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "More thought" }],
      defaultReasoningEffort: "medium", serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }], defaultServiceTier: null }]),
    dispose: vi.fn(async () => undefined),
  };
}

describe("Studio Codex account and runtime endpoints", () => {
  let root: string;
  let service: ReturnType<typeof mockService>;
  const post = (body: unknown = {}) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inkos-codex-studio-")); service = mockService(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const server = () => createStudioServer({} as never, root, { codexAccountService: service as unknown as CodexAccountService });

  it("starts, repeats, recovers status, cancels and logs out without exposing auth internals", async () => {
    const app = server();
    const started = await app.request("/api/v1/codex/login", post());
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(await started.json()).toMatchObject({ loginId: "login-1", status: "pending", userCode: "CODE-1234" });
    expect((await (await app.request("/api/v1/codex/login", post())).json()).loginId).toBe("login-1");
    expect(await (await app.request("/api/v1/codex/account")).json()).toMatchObject({ login: { status: "pending" } });
    expect((await app.request("/api/v1/codex/login/cancel", post({ loginId: "stale" }))).status).toBe(409);
    expect(service.cancelLogin).not.toHaveBeenCalled();
    expect((await app.request("/api/v1/codex/login/cancel", post({ loginId: "login-1" }))).status).toBe(200);
    expect((await app.request("/api/v1/codex/login/cancel", post({ loginId: "login-1" }))).status).toBe(200);
    expect(service.cancelLogin).toHaveBeenCalledTimes(1);
    expect((await app.request("/api/v1/codex/logout", post())).status).toBe(200);
    expect(await (await app.request("/api/v1/codex/account")).json()).toMatchObject({ connected: false, login: null });
  });

  it("projects safe status fields and hides raw login failures and credentials", async () => {
    service.readAccount.mockResolvedValue({ connected: true, requiresOpenaiAuth: false,
      account: { type: "chatgpt", email: "writer@example.test", planType: "plus", accessToken: "SECRET" },
      login: { loginId: "x", status: "failed", error: "SECRET upstream error", userCode: "OLD-CODE", verificationUrl: "https://evil.test/" }, token: "SECRET",
    } as never);
    const app = server();
    const status = await (await app.request("/api/v1/codex/account")).text();
    expect(status).toContain("writer@example.test");
    expect(status).not.toMatch(/SECRET|OLD-CODE|evil\.test/);
    service.startDeviceLogin.mockRejectedValue(new Error("SECRET auth token"));
    const failure = await app.request("/api/v1/codex/login", post());
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("SECRET");
  });

  it("blocks cross-origin, rebinding, cross-site and form-based account mutations", async () => {
    const app = server();
    for (const path of ["login", "logout", "login/cancel"]) {
      expect((await app.request(`/api/v1/codex/${path}`, { ...post(), headers: { "Content-Type": "application/json", Origin: "https://evil.test" } })).status).toBe(403);
      expect((await app.request(`http://evil.test/api/v1/codex/${path}`, post())).status).toBe(403);
      expect((await app.request(`/api/v1/codex/${path}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await app.request(`/api/v1/codex/${path}`, { ...post(), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    }
    expect(service.startDeviceLogin).not.toHaveBeenCalled();
    expect(service.logout).not.toHaveBeenCalled();
    expect(service.cancelLogin).not.toHaveBeenCalled();
  });

  it("allows only catalog-supported model/effort/speed combinations", async () => {
    const app = server();
    const put = (body: unknown) => ({ ...post(body), method: "PUT" });
    const saved = await app.request("/api/v1/codex/settings", put({ model: "codex-test", reasoningEffort: "high", serviceTier: "fast" }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ settings: { reasoningEffort: "high", serviceTier: "fast" } });
    for (const body of [{ model: "invented" }, { reasoningEffort: "ultra" }, { serviceTier: "ultrafast" }, { apiKey: "never" }, [], { model: 2 }]) {
      expect((await app.request("/api/v1/codex/settings", put(body))).status).toBe(400);
    }
    expect(service.updateSettings).toHaveBeenCalledTimes(1);
    expect((await app.request("/api/v1/codex/settings", put({ model: null, reasoningEffort: "medium", serviceTier: "default" }))).status).toBe(200);
  });
});
