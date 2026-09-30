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
