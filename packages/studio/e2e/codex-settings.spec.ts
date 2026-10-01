import { test, expect, type Page } from "@playwright/test";

async function mockCodex(page: Page) {
  const state = {
    account: { connected: false, account: null, requiresOpenaiAuth: true, login: null } as Record<string, unknown>,
    settings: { model: "codex-first", reasoningEffort: "high", serviceTier: "fast" } as Record<string, unknown>,
    starts: 0, cancels: 0, logouts: 0, saves: [] as unknown[], failStart: false,
  };
  await page.route("**/api/v1/project", (route) => route.fulfill({ json: { name: "Codex test", language: "en", languageExplicit: true } }));
  await page.route("**/api/v1/codex/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1/codex", "");
    if (path === "/account") return route.fulfill({ json: state.account });
    if (path === "/login") {
      state.starts++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (state.failStart) return route.fulfill({ status: 503, json: { error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable. Retry sign-in." } } });
      const login = { loginId: `login-${state.starts}`, status: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "CODE-1234" };
      state.account = { ...state.account, login };
      return route.fulfill({ json: login });
    }
    if (path === "/login/cancel") {
      state.cancels++;
      const login = state.account.login as Record<string, unknown>;
      expect(route.request().postDataJSON()).toEqual({ loginId: login.loginId });
      state.account = { ...state.account, login: { loginId: login.loginId, status: "cancelled" } };
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/logout") {
      state.logouts++;
      state.account = { connected: false, account: null, requiresOpenaiAuth: true, login: null };
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/models") return route.fulfill({ json: { models: [
      { id: "codex-first", model: "codex-first", displayName: "Codex First", description: "First model", isDefault: true,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "More thought" }],
        serviceTiers: [{ id: "fast", name: "Fast", description: "Faster processing" }], defaultServiceTier: null },
      { id: "codex-second", model: "codex-second", displayName: "Codex Second", description: "Second model", isDefault: false,
        defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick reasoning" }], serviceTiers: [], defaultServiceTier: null },
    ] } });
    if (path === "/settings") {
      if (route.request().method() === "PUT") {
        state.settings = route.request().postDataJSON();
        if (state.settings.model === null) delete state.settings.model;
        state.saves.push({ ...state.settings });
      }
      return route.fulfill({ json: { settings: state.settings } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected mock request" } });
  });
  await page.goto("/#/settings");
  await expect(page.getByTestId("codex-account-status")).toHaveText("Not signed in to ChatGPT");
  return state;
}

test("device login resists repeat clicks, resumes after navigation, and cancels cleanly", async ({ page }) => {
  const state = await mockCodex(page);
  const card = page.getByTestId("codex-settings");
  await card.getByRole("button", { name: "Sign in with ChatGPT" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(card.getByTestId("codex-device-login")).toBeVisible();
  expect(state.starts).toBe(1);
  await expect(card.getByLabel("Device sign-in code")).toHaveText("CODE-1234");
  await expect(card.getByRole("link", { name: "Open ChatGPT sign-in" })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(await card.locator('input[type="password"]').count()).toBe(0);
  await page.goto("/#/");
  await page.goBack();
  await expect(page.getByTestId("codex-device-login")).toBeVisible();
  await card.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(card.getByTestId("codex-device-login")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Sign in with ChatGPT" })).toBeVisible();
  expect(state.cancels).toBe(1);
  await page.reload();
  await expect(card.getByTestId("codex-device-login")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Sign in with ChatGPT" })).toBeVisible();
});

test("failed and expired login can retry; completed login can sign out", async ({ page }) => {
  const state = await mockCodex(page);
  const card = page.getByTestId("codex-settings");
  state.failStart = true;
  await card.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(card.getByRole("alert")).toHaveText("Codex is unavailable. Retry sign-in.");
  state.failStart = false;
  await card.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(card.getByTestId("codex-device-login")).toBeVisible();
  state.account = { ...state.account, login: { loginId: "login-2", status: "failed" } };
  await expect(card.getByRole("alert")).toHaveText("Sign-in failed or expired. Please try again.");
  await expect(card.getByTestId("codex-device-login")).toHaveCount(0);
  await card.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(card.getByTestId("codex-device-login")).toBeVisible();
  state.account = { connected: true, account: { type: "chatgpt", email: "writer@example.test", planType: "plus" }, requiresOpenaiAuth: true, login: { loginId: "login-3", status: "completed" } };
  await expect(card.getByTestId("codex-account-status")).toContainText("writer@example.test");
  await expect(card.getByTestId("codex-device-login")).toHaveCount(0);
  await card.getByRole("button", { name: "Sign out of Codex" }).click();
  await expect(card.getByTestId("codex-account-status")).toHaveText("Not signed in to ChatGPT");
  expect(state.logouts).toBe(1);
});

test("model changes keep effort and speed valid and persist across reload", async ({ page }) => {
  const state = await mockCodex(page);
  const card = page.getByTestId("codex-settings");
  await expect(card.getByLabel("Service speed")).toHaveValue("fast");
  await card.getByLabel("Codex model", { exact: true }).selectOption("codex-second");
  await expect(card.getByLabel("Reasoning effort")).toHaveValue("low");
  await expect(card.getByLabel("Service speed")).toHaveValue("default");
  await expect(card.getByLabel("Service speed").locator("option")).toHaveCount(1);
  await card.getByRole("button", { name: "Save Codex settings" }).click();
  await expect(card.getByRole("status")).toHaveText("Codex settings saved for the next run");
  expect(state.saves).toEqual([{ model: "codex-second", reasoningEffort: "low", serviceTier: "default" }]);
  await expect(card.getByRole("button", { name: "Save Codex settings" })).toBeDisabled();
  await page.reload();
  await expect(card.getByLabel("Codex model", { exact: true })).toHaveValue("codex-second");
  await expect(card.getByLabel("Reasoning effort")).toHaveValue("low");
  await card.getByLabel("Codex model", { exact: true }).selectOption("");
  await expect(card.getByLabel("Reasoning effort")).toHaveValue("medium");
});

test("Codex-ready projects do not need legacy env files in Doctor", async ({ page }) => {
  await mockCodex(page);
  await page.route("**/api/v1/doctor", route => route.fulfill({ json: {
    inkosJson: true, projectEnv: false, globalEnv: false, booksDir: true, bookCount: 0, llmConnected: true,
  } }));
  await page.getByRole("button", { name: "Doctor", exact: true }).click();
  await expect(page.getByText("Codex account and model settings", { exact: true })).toBeVisible();
  await expect(page.getByText("All checks passed — environment is healthy", { exact: true })).toBeVisible();
  await expect(page.getByText("Optional external-service configuration", { exact: true })).toHaveCount(2);
});

test("market scan renders Codex-backed results and retained history without directing the user to API keys", async ({ page }) => {
  const state = await mockCodex(page);
  state.account = { connected: true, account: { type: "chatgpt", email: "writer@example.test", planType: "plus" }, requiresOpenaiAuth: true, login: null };
  let scans = 0;
  const result = { marketSummary: "Codex market fixture", recommendations: [{ platform: "qidian", genre: "fantasy", concept: "The Clockmaker", reasoning: "Grounded in the supplied ranking", benchmarkTitles: ["Fixture ranking"] }] };
  await page.route("**/api/v1/radar/scan", async route => { scans++; await route.fulfill({ json: result }); });
  await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: scans ? [{ file: "scan-fixture.json", timestamp: "2026-01-01T00:00:00Z", summaryPreview: result.marketSummary, result }] : [] } }));
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await page.getByRole("button", { name: "Scan Market", exact: true }).click();
  await expect(page.getByText("The Clockmaker", { exact: true })).toBeVisible();
  await expect(page.getByText("Scan History", { exact: true })).toBeVisible();
  await expect(page.getByText(/API Key.*not set|API Key 未设置/)).toHaveCount(0);
  expect(scans).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await expect(page.getByText("Codex market fixture", { exact: true })).toBeVisible();
});

test("market scan shows phases, suppresses repeated clicks and resumes after navigation", async ({ page }) => {
  await mockCodex(page);
  let scans = 0;
  let phase = "fetching";
  let running = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = { marketSummary: "Resumed market fixture", recommendations: [] };
  await page.route("**/api/v1/radar/status", route => route.fulfill({ json: { running, phase, startedAt: Date.now() - 5000,
    ...(!running && scans ? { result } : {}) } }));
  await page.route("**/api/v1/radar/scan", async route => {
    scans++; running = true;
    await gate;
    running = false; phase = "complete";
    await route.fulfill({ json: result }).catch(() => {});
  });
  await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: [] } }));
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await page.getByRole("button", { name: "Scan Market", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole("status")).toContainText("Fetching ranking evidence");
  expect(scans).toBe(1);
  phase = "analyzing";
  await expect(page.getByRole("status")).toContainText("Codex is analyzing");
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Codex is analyzing");
  await expect(page.getByRole("button", { name: "Scanning...", exact: true })).toBeDisabled();
  release();
  await expect(page.getByText("Resumed market fixture", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan Market", exact: true })).toBeEnabled();
  expect(scans).toBe(1);
});

test("failed market scan keeps actionable diagnostics visible and permits retry", async ({ page }) => {
  await mockCodex(page);
  let scans = 0;
  await page.route("**/api/v1/radar/status", route => route.fulfill({ json: { running: false, phase: "idle" } }));
  await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/radar/scan", route => ++scans === 1
    ? route.fulfill({ status: 500, json: { error: "Worker deadline exceeded (code=WORKER_TIMEOUT)" } })
    : route.fulfill({ json: { marketSummary: "Retried market fixture", recommendations: [] } }));
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await page.getByRole("button", { name: "Scan Market", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("WORKER_TIMEOUT");
  await page.getByRole("button", { name: "Scan Market", exact: true }).click();
  await expect(page.getByText("Retried market fixture", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(scans).toBe(2);
});

for (const outcome of ["complete", "error"] as const) {
  test(`market scan restores ${outcome} when it finishes while the user is away`, async ({ page }) => {
    await mockCodex(page);
    let running = false;
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const result = { marketSummary: "Completed while away", recommendations: [] };
    const error = "Scan failed while away (code=WORKER_RESULT_INVALID)";
    await page.route("**/api/v1/radar/status", route => route.fulfill({ json: { running,
      phase: running ? "analyzing" : started ? outcome : "idle", startedAt: Date.now(),
      ...(!running && started ? outcome === "complete" ? { result } : { error } : {}) } }));
    await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/v1/radar/scan", async route => {
      started = true; running = true; await gate; running = false;
      await route.fulfill(outcome === "complete" ? { json: result } : { status: 500, json: { error } }).catch(() => {});
    });
    await page.getByRole("button", { name: "Radar", exact: true }).click();
    await page.getByRole("button", { name: "Scan Market", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.goto("/#/settings");
    release();
    await expect.poll(() => running).toBe(false);
    await page.getByRole("button", { name: "Radar", exact: true }).click();
    if (outcome === "complete") await expect(page.getByText(result.marketSummary, { exact: true })).toBeVisible();
    else await expect(page.getByRole("alert")).toContainText(error);
    await expect(page.getByRole("button", { name: "Scan Market", exact: true })).toBeEnabled();
  });
}

test("a delayed running status cannot resurrect a completed scan", async ({ page }) => {
  await mockCodex(page);
  let running = false;
  let statusHeld = false;
  let releaseScan!: () => void;
  let releaseStatus!: () => void;
  const scanGate = new Promise<void>(resolve => { releaseScan = resolve; });
  const statusGate = new Promise<void>(resolve => { releaseStatus = resolve; });
  const result = { marketSummary: "Authoritative completed scan", recommendations: [] };
  await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/radar/status", async route => {
    if (running && !statusHeld) {
      statusHeld = true;
      await statusGate;
      return route.fulfill({ json: { running: true, phase: "analyzing", startedAt: Date.now() } });
    }
    return route.fulfill({ json: { running: false, phase: "idle" } });
  });
  await page.route("**/api/v1/radar/scan", async route => {
    running = true; await scanGate; running = false;
    await route.fulfill({ json: result });
  });
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await page.getByRole("button", { name: "Scan Market", exact: true }).click();
  await expect.poll(() => statusHeld).toBe(true);
  releaseScan();
  await expect(page.getByText(result.marketSummary, { exact: true })).toBeVisible();
  const lateStatus = page.waitForResponse(response => response.url().endsWith("/radar/status"));
  releaseStatus();
  await lateStatus;
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scan Market", exact: true })).toBeEnabled();
});

test("an old terminal status cannot overwrite a newer requested scan", async ({ page }) => {
  await mockCodex(page);
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = { marketSummary: "Newer requested scan", recommendations: [] };
  await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/radar/status", async route => {
    held = true; await gate;
    await route.fulfill({ json: { running: false, phase: "error", error: "Old scan failed" } });
  });
  await page.route("**/api/v1/radar/scan", route => route.fulfill({ json: result }));
  await page.getByRole("button", { name: "Radar", exact: true }).click();
  await expect.poll(() => held).toBe(true);
  await page.getByRole("button", { name: "Scan Market", exact: true }).click();
  await expect(page.getByText(result.marketSummary, { exact: true })).toBeVisible();
  const lateStatus = page.waitForResponse(response => response.url().endsWith("/radar/status"));
  release(); await lateStatus;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(result.marketSummary, { exact: true })).toBeVisible();
});

for (const failure of ["transport", "conflict"] as const) {
  test(`market scan reconciles ${failure} failure with a still-running server scan`, async ({ page }) => {
    await mockCodex(page);
    let running = false;
    let scans = 0;
    const result = { marketSummary: "Recovered server scan", recommendations: [] };
    await page.route("**/api/v1/radar/history", route => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/v1/radar/status", route => route.fulfill({ json: { running,
      phase: running ? "analyzing" : scans ? "complete" : "idle", startedAt: Date.now(),
      ...(!running && scans ? { result } : {}) } }));
    await page.route("**/api/v1/radar/scan", route => {
      scans++; running = true;
      return failure === "transport" ? route.abort("failed") : route.fulfill({ status: 409, json: { error: "A market scan is already running" } });
    });
    await page.getByRole("button", { name: "Radar", exact: true }).click();
    await page.getByRole("button", { name: "Scan Market", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Codex is analyzing");
    await expect(page.getByRole("button", { name: "Scanning...", exact: true })).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    running = false;
    await expect(page.getByText(result.marketSummary, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan Market", exact: true })).toBeEnabled();
    expect(scans).toBe(1);
  });
}

for (const outcome of ['answered', 'blocked'] as const) {
  for (const timing of ['buffered', 'flushed', 'terminal'] as const) {
  test(`main chat settles ${outcome} once with ${timing} SSE text, HTTP and reload`, async ({ page }) => {
    // Exercise the real chat UI while fixture endpoints supply the same public
    // SSE/HTTP contract verified against the real main Agent in backend tests.
    // Freeze timers after setup to control the 48ms batch/HTTP race explicitly.
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.addInitScript(() => {
      class FixtureEvents extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
        readyState = 1; onopen: ((event: Event) => void) | null = null; onerror = null;
        constructor(_url: string) {
          super();
          const browser = window as unknown as { fixtureEvents: FixtureEvents[] };
          (browser.fixtureEvents ??= []).push(this);
          queueMicrotask(() => this.onopen?.(new Event('open')));
        }
        close() { this.readyState = 2; }
      }
      (window as unknown as { EventSource: unknown }).EventSource = FixtureEvents;
    });
    await mockCodex(page);
    let session: Record<string, any> | undefined;
    let chatRequest: Record<string, any> | undefined;
    let sends = 0;
    const response = outcome === 'answered' ? 'A scene is a unit of dramatic action.' : 'The required source is unavailable; no work has been created.';
    await page.route('**/api/v1/sessions**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/v1/sessions' && route.request().method() === 'POST') {
        const requested = route.request().postDataJSON();
        session = { ...requested, bookId: null, sessionKind: 'chat', profileId: 'workspace-default', workId: null,
          title: 'Completion fixture', updatedAt: Date.now(), createdAt: Date.now(), messageCount: 0, messages: [] };
        return route.fulfill({ json: { session } });
      }
      if (url.pathname === '/api/v1/sessions') return route.fulfill({ json: { sessions: session ? [session] : [] } });
      return route.fulfill({ json: { session, chatRequest } });
    });
    await page.route('**/api/v1/agent', async route => {
      sends++;
      const request = route.request().postDataJSON();
      const sessionId = request.sessionId;
      const startedAt = Date.now();
      session = { ...session, sessionId, messageCount: 2, messages: [
        { role: 'user', content: request.instruction, timestamp: startedAt },
        { role: 'assistant', content: response, timestamp: startedAt + 1 },
      ] };
      chatRequest = { sessionId, requestId: request.clientRequestId, startedAt, completedAt: startedAt + 2,
        status: outcome === 'blocked' ? 'failed' : 'completed', completionStatus: outcome,
        ...(outcome === 'blocked' ? { error: { code: 'AGENT_TASK_INCOMPLETE', message: response }, retry: { text: request.instruction } } : {}),
      };
      await page.evaluate(({ sessionId, response, outcome, timing }) => {
        for (const stream of (window as unknown as { fixtureEvents: Array<EventTarget & { readyState: number }> }).fixtureEvents) {
          if (stream.readyState !== 1) continue;
          stream.dispatchEvent(new MessageEvent('draft:delta', { data: JSON.stringify({ sessionId, text: response }) }));
          if (timing === 'terminal') stream.dispatchEvent(new MessageEvent(outcome === 'answered' ? 'agent:complete' : 'agent:error', { data: JSON.stringify({ sessionId }) }));
        }
      }, { sessionId, response, outcome, timing });
      if (timing === 'flushed') await page.clock.fastForward(100);
      await route.fulfill({ status: outcome === 'blocked' ? 422 : 200, json: {
        response, completionStatus: outcome, session, details: { toolExecutions: [] },
        ...(outcome === 'blocked' ? { error: { code: 'AGENT_TASK_INCOMPLETE', message: response } } : {}),
      } });
    });
    await page.goto('/#/chat');
    const input = page.getByPlaceholder('Enter command...');
    await expect(input).toBeEnabled();
    await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
    await input.fill(outcome === 'answered' ? 'Explain a scene.' : 'Use the unavailable source.');
    const reply = page.waitForResponse(result => result.url().endsWith('/api/v1/agent'));
    await input.press('Enter');
    await (await reply).finished();
    // Wait for HTTP settlement, then run every buffered text timer before the
    // uniqueness assertion. A fleeting single response cannot pass this test.
    if (outcome === 'blocked') await expect(page.getByRole('button', { name: 'Retry last message' })).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Add skill', exact: true })).toBeEnabled();
    await page.clock.fastForward(1_000);
    await expect(page.getByText(response, { exact: true })).toHaveCount(1);
    await expect(page.getByText(/Agent ended without an explicit completion result/)).toHaveCount(0);
    await expect(page.getByText(/"status"\s*:\s*"(answered|blocked)"/)).toHaveCount(0);
    await page.clock.resume();
    await page.reload();
    await expect(page.getByText(response, { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Retry last message' })).toHaveCount(outcome === 'blocked' ? 1 : 0);
    expect(sends).toBe(1);
  });
  }
}
