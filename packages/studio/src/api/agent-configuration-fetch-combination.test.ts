import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAuthenticationOwner, createCodexAccountService, type CodexClient } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "./server.js";
import { createAgentConfigurationController, createAgentConfigurationTransport } from "../hooks/agent-configuration-controller";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
});
afterEach(() => { vi.unstubAllEnvs(); });

// Only the lowest native protocol boundary is synthetic. All Fetch requests use
// a real local TCP listener and the mounted Studio routes, public Core service,
// attempt lifecycle, owner and SQLite. This proves no OAuth or inference.
it("recovers a known handle across real Fetch abort, lost Close response and remount without replaying authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-fetch-combination-"));
  const home = join(root, ".inkos", "codex", "home");
  await mkdir(home, { recursive: true });
  const entered = deferred(), release = deferred();
  const calls: Array<{ method: string; params: unknown }> = [];
  const notifications = new Set<(method: string, params: unknown) => void>();
  const closes = new Set<() => void>();
  let closed = false;
  const peer: CodexClient = {
    cwd: root, codexHome: home, get closed() { return closed; },
    async request<T>(method: string, params: unknown = {}): Promise<T> {
      calls.push({ method, params });
      if (method === "account/login/start") {
        entered.resolve(); await release.promise;
        return { type: "chatgptDeviceCode", loginId: "native-fetch-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "OFFLINE" } as T;
      }
      if (method === "account/login/cancel") return { status: "canceled" } as T;
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true } as T;
      if (method === "config/read") return { config: {} } as T;
      if (method === "model/list") return { data: [], nextCursor: null } as T;
      throw new Error(`Unexpected offline protocol call: ${method}`);
    },
    onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
    onRequest() { return () => {}; },
    onClose(listener) { closes.add(listener); return () => { closes.delete(listener); }; },
    async close() { closed = true; for (const listener of closes) listener(); },
  };
  const factory = vi.fn(async () => peer);
  const service = createCodexAccountService({ projectDir: root, clientFactory: factory });
  const app = createStudioServer({} as never, root, { codexAccountService: service });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
  const base = `http://127.0.0.1:${address.port}`;
  const requests: Array<{ path: string; body: unknown; aborted: boolean }> = [];
  const networkFetch: typeof fetch = async (input, init) => {
    const path = String(input), record = { path, body: init?.body ? JSON.parse(String(init.body)) : null, aborted: false };
    requests.push(record);
    try { return await fetch(new URL(path, base), init); }
    catch (error) { record.aborted = (error as Error).name === "AbortError"; throw error; }
  };
  const transport = createAgentConfigurationTransport(networkFetch);
  const controllers: ReturnType<typeof createAgentConfigurationController>[] = [];
  const mount = () => { const controller = createAgentConfigurationController(transport, undefined, 300); controllers.push(controller); return controller; };
  const count = (method: string) => calls.filter(call => call.method === method).length;
  try {
    const original = mount(); await original.refresh();
    expect(original.getSnapshot().state?.connection?.phase).toBe("signed-out");
    original.connectionIntent({ action: "connect", target: original.getSnapshot().target });
    await entered.promise;
    const handle = (requests.find(request => request.path.endsWith("/login"))!.body as { attemptHandle: string }).attemptHandle;
    expect(handle).toBeTruthy();
    expect(requests.filter(request => request.path.endsWith("/login/reserve"))).toHaveLength(1);
    original.dispose();
    await vi.waitFor(() => expect(requests.find(request => request.path.endsWith("/login"))?.aborted).toBe(true));
    expect(count("account/login/cancel")).toBe(0);
    expect(new CodexAuthenticationOwner(peer).snapshot()).toMatchObject({ localState: "transitioning" });

    const returned = mount(); await returned.refresh();
    expect(returned.getSnapshot().canCloseConnection).toBe(true);
    returned.closeConnection();
    await vi.waitFor(() => expect(new CodexAuthenticationOwner(peer).snapshot()).toMatchObject({ localState: "unknown", operationId: null }));
    // The native start reply is still held, so this genuine Fetch Close times
    // out after Core accepted its fence. The browser has no response receipt.
    await vi.waitFor(() => expect(requests.find(request => request.path.endsWith("/login/close"))?.aborted).toBe(true));
    expect(returned.getSnapshot().authDetail?.en).toContain("uncertain");
    returned.dispose(); release.resolve();
    await vi.waitFor(() => expect(count("account/login/cancel")).toBe(1));

    const recovered = mount(); await recovered.refresh();
    expect(recovered.getSnapshot().authCloseScope).toBe("attempt");
    const closeRequestsBefore = requests.filter(request => request.path.endsWith("/login/close")).length;
    recovered.closeConnection();
    await vi.waitFor(() => expect(recovered.getSnapshot().authCloseResult).toMatchObject({ attemptHandle: handle, state: "closed", cleanup: "cancel-acknowledged" }));
    const closeRequests = requests.filter(request => request.path.endsWith("/login/close"));
    expect(closeRequests).toHaveLength(closeRequestsBefore + 1);
    expect(closeRequests.map(request => request.body)).toEqual([{ attemptHandle: handle }, { attemptHandle: handle }]);
    expect(requests.filter(request => request.path.endsWith("/login/reserve"))).toHaveLength(1);
    expect(count("account/login/start")).toBe(1); expect(count("account/login/cancel")).toBe(1);
    expect(calls.find(call => call.method === "account/login/cancel")?.params).toEqual({ loginId: "native-fetch-login" });
    expect(count("account/logout")).toBe(0); expect(factory).toHaveBeenCalledTimes(1);
    expect(recovered.getSnapshot().state?.execution).toBeNull();
  } finally {
    release.resolve(); for (const controller of controllers) controller.dispose();
    await shutdownStudioServer(app);
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
