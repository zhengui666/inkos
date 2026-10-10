import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAccountService, readAgentSettings, type CodexClient, type CodexAccountService } from "@actalk/inkos-core";
import type { DeviceLoginAttemptService } from "../api/agent-configuration";
import type { DeviceLoginAttemptCloseResult } from "../shared/agent-configuration";
import { createStudioServer, shutdownStudioServer } from "../api/server";
import { createAgentConfigurationController, createAgentConfigurationTransport } from "../hooks/agent-configuration-controller";
import { AgentSettings } from "./AgentSettings";
import { ProjectSettings } from "./ProjectSettings";
import type { TFunction } from "../hooks/use-i18n";

// Replace only the React subscription boundary. Every intent uses the real controller,
// HTTP transport, mounted production routes and filesystem CAS. Attempt settlement
// is an explicit approved-contract fixture until the new Core implementation is imported.
const holder = vi.hoisted(() => ({ controller: null as ReturnType<typeof createAgentConfigurationController> | null }));
vi.mock("../hooks/use-agent-configuration", () => ({ useAgentConfiguration: () => {
  const controller = holder.controller!;
  return { controller, snapshot: controller.getSnapshot() };
} }));

// Offline protocol peer: no process, credentials, OAuth or model execution.
class UiPeer implements CodexClient {
  readonly codexHome: string;
  closed = false;
  authenticated = false;
  readonly calls: string[] = [];
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  constructor(readonly cwd: string) { this.codexHome = join(cwd, ".inkos", "codex", "home"); }
  async request<T>(method: string, _params?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    options?.signal?.throwIfAborted(); this.calls.push(method);
    let result: unknown;
    switch (method) {
      case "account/read": result = { account: this.authenticated ? { type: "chatgpt", email: "hidden@example.test", planType: "fixture" } : null, requiresOpenaiAuth: true }; break;
      case "model/list": result = { data: ["fixture-default", "fixture-other"].map((model, index) => ({ id: model, model, isDefault: index === 0,
        defaultReasoningEffort: "high", defaultServiceTier: "default", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "fast" }] })), nextCursor: null }; break;
      case "config/read": result = { config: {} }; break;
      case "account/login/start": result = { type: "chatgptDeviceCode", loginId: "ui-attempt", verificationUrl: "https://auth.openai.com/codex/device", userCode: "UI-CODE" }; break;
      case "account/login/cancel": result = {}; break;
      case "account/logout": this.authenticated = false; result = {}; break;
      default: throw new Error(`Unexpected fixture method ${method}`);
    }
    return result as T;
  }
  onNotification(listener: (method: string, params: unknown) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest() { return () => {}; }
  onClose() { return () => {}; }
  async close() { this.closed = true; }
  complete() { this.authenticated = true; for (const listener of this.notifications) listener("account/login/completed", { loginId: "ui-attempt", success: true }); }
}

/** Offline contract injection only. New Core attempt management must be re-tested after its import. */
function installAttemptContractFixture(service: CodexAccountService) {
  const start = service.startDeviceLogin.bind(service), cancel = service.cancelLogin.bind(service);
  const attempts = new Map<string, { expiresAt: number; closed: boolean; loginId?: string;
    pending?: ReturnType<typeof start>; cleanup?: Promise<void> }>();
  let nextHandle = 0;
  const fixture: DeviceLoginAttemptService = {
    reserveDeviceLoginAttempt() {
      const attemptHandle = `fixture-attempt-${++nextHandle}`, expiresAt = Date.now() + 60_000;
      attempts.set(attemptHandle, { expiresAt, closed: false });
      return { attemptHandle, expiresAt };
    },
    startDeviceLogin({ attemptHandle }) {
      const attempt = attempts.get(attemptHandle);
      if (!attempt || attempt.closed || attempt.expiresAt <= Date.now()) return Promise.reject(new Error("The fixture attempt is no longer startable"));
      attempt.pending ??= start().then(async login => {
        attempt.loginId = login.loginId;
        if (attempt.closed) { attempt.cleanup ??= cancel(login.loginId); await attempt.cleanup; }
        return login;
      });
      return attempt.pending;
    },
    async closeDeviceLoginAttempt(attemptHandle): Promise<DeviceLoginAttemptCloseResult> {
      const attempt = attempts.get(attemptHandle);
      if (!attempt || attempt.expiresAt <= Date.now()) return { attemptHandle, state: "unknown-or-expired", cleanup: "not-applicable" };
      const repeated = attempt.closed; attempt.closed = true;
      if (!attempt.pending) return { attemptHandle, state: repeated ? "already-terminal" : "closed", cleanup: "not-started" };
      if (!attempt.loginId) {
        // Fence immediately; the pending fixture start performs its exact-ID cleanup when it resolves.
        return { attemptHandle, state: repeated ? "already-terminal" : "closed", cleanup: "unconfirmed" };
      }
      attempt.cleanup ??= cancel(attempt.loginId);
      try { await attempt.cleanup; return { attemptHandle, state: repeated ? "already-terminal" : "closed", cleanup: "cancel-acknowledged" }; }
      catch { return { attemptHandle, state: "closed", cleanup: "unconfirmed" }; }
    },
  };
  Object.assign(service, fixture); // Same injected service object; production code never supplies this shim.
}

type Element = ReactElement<Record<string, unknown>>;
function native(node: ReactNode, tag: string): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (typeof child.type === "function") {
      found.push(...native((child.type as (props: Record<string, unknown>) => ReactNode)(child.props), tag));
    } else {
      if (child.type === tag) found.push(child);
      found.push(...native(child.props.children as ReactNode, tag));
    }
  });
  return found;
}
function contents(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? contents(child.props.children) : String(child)).join("");
}
const tree = (isZh = false) => AgentSettings({ isZh });
function button(label: string, isZh = false) {
  const result = native(tree(isZh), "button").find(item => contents(item.props.children as ReactNode) === label);
  expect(result, `missing ${label}`).toBeDefined(); return result!;
}
function click(label: string) {
  const control = button(label); expect(control.props.disabled).toBeFalsy(); (control.props.onClick as () => void)();
}
function choose(label: string, value: string) {
  const control = native(tree(), "select").find(item => item.props["aria-label"] === label);
  expect(control, `missing native select ${label}`).toBeDefined();
  (control!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

describe("native UI → API → Core observations/CAS and approved attempt-contract fixture (offline)", () => {
  let root: string;
  let peer: UiPeer;
  let app: ReturnType<typeof createStudioServer>;
  let factory: ReturnType<typeof vi.fn<() => Promise<CodexClient>>>;
  let controller: ReturnType<typeof createAgentConfigurationController>;
  const http: Array<{ method: string; path: string }> = [];
  beforeEach(async () => {
    vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
    vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
    root = await mkdtemp(join(tmpdir(), "inkos-native-ui-")); await mkdir(join(root, ".inkos", "codex", "home"), { recursive: true, mode: 0o700 });
    peer = new UiPeer(root); factory = vi.fn(async (): Promise<CodexClient> => peer);
    const service = createCodexAccountService({ projectDir: root, clientFactory: factory });
    installAttemptContractFixture(service);
    app = createStudioServer({} as never, root, { codexAccountService: service });
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(new URL(String(input), "http://localhost"), init);
      http.push({ method: request.method, path: new URL(request.url).pathname }); return app.request(request);
    };
    controller = createAgentConfigurationController(createAgentConfigurationTransport(fetchImpl)); holder.controller = controller; http.length = 0;
    await controller.refresh();
  });
  afterEach(async () => { controller.dispose(); holder.controller = null; await shutdownStudioServer(app); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const settled = () => vi.waitFor(() => expect(controller.getSnapshot().authBusy).toBeNull());
  async function signIn() {
    click("Sign in with ChatGPT"); await settled();
    expect(renderToStaticMarkup(tree())).toContain("UI-CODE");
    peer.complete();
    await vi.waitFor(async () => {
      await controller.refreshState();
      expect(controller.getSnapshot().state?.account?.type).toBe("chatgpt");
      expect(controller.getSnapshot().state?.catalog).not.toBeNull();
      expect(controller.getSnapshot().state?.connection?.phase).toBe("signed-in");
    });
  }

  it("mounts this panel in ProjectSettings and dispatches real native model/effort/speed/save/bind controls", async () => {
    const html = renderToStaticMarkup(createElement(ProjectSettings, { nav: { toDashboard() {}, toServices() {} }, theme: "dark", t: ((key: string) => key) as TFunction }));
    expect(html).toContain('aria-label="Agent defaults"'); expect(html).toContain('name="agent-settings-harness"');
    expect(http.every(call => call.method === "GET")).toBe(true); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    await signIn();
    choose("Model", "fixture-default"); choose("Reasoning effort", "high"); choose("Service speed", "fast"); choose("Model", "fixture-other");
    expect(controller.getSnapshot().draft).toEqual({ model: "fixture-other", effort: "high", speed: "fast" });
    click("Save defaults · Codex"); await vi.waitFor(() => expect(controller.getSnapshot().savePhase).toBe("saved"));
    expect((await readAgentSettings(root)).harnessPreferences.codex).toEqual(controller.getSnapshot().draft);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    click("Bind current ChatGPT model connection"); await settled();
    const bound = await readAgentSettings(root); expect(bound.revision).toBe(2); expect(bound.modelConnectionRef).toBeTruthy();
    expect(controller.getSnapshot().state?.connection?.connectionRef).toBe(bound.modelConnectionRef);
    const rendered = renderToStaticMarkup(tree()); expect(rendered).toContain("execution remains unverified"); expect(rendered).not.toContain("hidden@example.test");
    expect(controller.getSnapshot().state?.execution).toBeNull(); expect(factory).toHaveBeenCalledTimes(1);
    expect(http.some(call => call.method === "POST" && call.path.endsWith("/bind"))).toBe(true);
    expect(http.some(call => call.method === "PUT" && call.path.endsWith("/settings"))).toBe(true);
  });

  it("saves Pi pending connection through its native radio without inheriting Codex identity, speed or binding", async () => {
    await signIn(); const callsBeforePi = peer.calls.length;
    const radio = native(tree(), "input").find(item => item.props.value === "pi")!;
    (radio.props.onChange as () => void)();
    await vi.waitFor(() => expect(controller.getSnapshot().state?.harnessId).toBe("pi"));
    expect(native(tree(), "select").map(item => item.props["aria-label"])).toEqual(["Model"]);
    expect(button("Sign in with ChatGPT").props.disabled).toBe(true);
    click("Save defaults · Pi"); await vi.waitFor(() => expect(controller.getSnapshot().savePhase).toBe("saved"));
    const saved = await readAgentSettings(root); expect(saved.selectedHarnessId).toBe("pi"); expect(saved.modelConnectionRef).toBeNull();
    expect(saved.harnessPreferences.pi).toEqual({ model: null, effort: null, speed: null });
    expect(peer.calls.length).toBe(callsBeforePi); expect(controller.getSnapshot().state?.account).toBeNull();
    expect(renderToStaticMarkup(tree(true))).toContain("已保存，待连接");
    expect(renderToStaticMarkup(tree())).toContain("Current run configuration remains frozen");
  });

  it("dispatches explicit Close and logout through native buttons, preserving unverified execution", async () => {
    click("Sign in with ChatGPT"); await settled(); click("Close and cancel sign-in"); await settled();
    expect(peer.calls.filter(method => method === "account/login/cancel")).toHaveLength(1);
    expect(controller.getSnapshot().state?.connection?.login?.status).toBe("cancelled");
    await signIn(); click("Sign out of ChatGPT"); await settled();
    expect(peer.calls.filter(method => method === "account/logout")).toHaveLength(1);
    expect(controller.getSnapshot().state?.account).toBeNull(); expect(controller.getSnapshot().state?.execution).toBeNull();
    expect(renderToStaticMarkup(tree())).toContain('role="status"'); expect(renderToStaticMarkup(tree())).toContain('aria-live="polite"');
  });
});
