import { Hono } from "hono";
import { selectCodexModel, CodexConfigurationError, type CodexAccountService } from "@actalk/inkos-core";
import { ApiError } from "./errors.js";
import { isCodexVerificationUrl } from "../shared/codex.js";

const FAILURE = "Codex is unavailable. Check that the official Codex CLI is installed, then retry.";
const LOGIN_FAILURE = "Codex sign-in did not complete. Cancel and try again.";

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "CODEX_INVALID_REQUEST", "A JSON object is required.");
  }
  return body as Record<string, unknown>;
}

/** Mounted after Studio's Host/Origin guards, including development allowlists. */
export function createCodexRoutes(service: CodexAccountService) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("Sec-Fetch-Site") === "cross-site") {
      throw new ApiError(403, "CODEX_CROSS_SITE_FORBIDDEN", "Cross-site Codex account access is not allowed.");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)
      && c.req.header("Content-Type")?.split(";")[0].trim() !== "application/json") {
      throw new ApiError(415, "CODEX_JSON_REQUIRED", "Codex changes require application/json.");
    }
    await next();
  });
  app.onError((error, c) => {
    // Never send or log raw app-server errors: upstream auth errors may contain secrets.
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    return c.json({ error: { code: "CODEX_UNAVAILABLE", message: FAILURE } }, 503);
  });

  app.get("/account", async (c) => {
    const state = await service.readAccount();
    const login = state.login;
    return c.json({
      connected: state.connected,
      requiresOpenaiAuth: state.requiresOpenaiAuth,
      account: state.account ? { type: "chatgpt", email: state.account.email, planType: state.account.planType } : null,
      login: login ? {
        loginId: login.loginId, status: login.status,
        ...(login.status === "pending" && login.verificationUrl && isCodexVerificationUrl(login.verificationUrl)
          ? { verificationUrl: login.verificationUrl, userCode: login.userCode } : {}),
        ...(login.status === "failed" ? { error: LOGIN_FAILURE } : {}),
      } : null,
    });
  });
  app.post("/login", async (c) => {
    const login = await service.startDeviceLogin();
    if (!isCodexVerificationUrl(login.verificationUrl)) throw new ApiError(502, "CODEX_INVALID_LOGIN_URL", LOGIN_FAILURE);
    return c.json({ loginId: login.loginId, status: "pending", verificationUrl: login.verificationUrl, userCode: login.userCode });
  });
  app.post("/login/cancel", async (c) => {
    const body = await jsonObject(c.req.raw);
    if (typeof body.loginId !== "string" || !body.loginId || body.loginId.length > 256) {
      throw new ApiError(400, "CODEX_INVALID_LOGIN_ID", "A valid login ID is required.");
    }
    const state = await service.readAccount();
    if (state.login?.loginId !== body.loginId) throw new ApiError(409, "CODEX_LOGIN_CHANGED", "This sign-in is no longer current. Refresh the account status.");
    if (state.login.status === "pending") await service.cancelLogin(body.loginId);
    return c.json({ ok: true });
  });
  app.post("/logout", async (c) => {
    await service.logout();
    return c.json({ ok: true });
  });
  app.get("/models", async (c) => c.json({ models: await service.listModels() }));
  app.get("/settings", async (c) => c.json({ settings: await service.readSettings() }));
  app.put("/settings", async (c) => {
    const body = await jsonObject(c.req.raw);
    if (Object.keys(body).some((key) => !["model", "reasoningEffort", "serviceTier"].includes(key))
      || (body.model !== undefined && body.model !== null && (typeof body.model !== "string" || !body.model.trim()))
      || (body.reasoningEffort !== undefined && typeof body.reasoningEffort !== "string")
      || (body.serviceTier !== undefined && typeof body.serviceTier !== "string")) {
      throw new ApiError(400, "CODEX_INVALID_SETTINGS", "Invalid Codex model, reasoning effort, or speed setting.");
    }
    const current = await service.readSettings();
    const models = await service.listModels();
    const modelId = body.model === null ? undefined : body.model ?? current.model;
    try {
      selectCodexModel(models, { model: modelId as string | undefined,
        reasoningEffort: (body.reasoningEffort ?? current.reasoningEffort) as typeof current.reasoningEffort,
        serviceTier: (body.serviceTier ?? current.serviceTier) as string });
    } catch (error) {
      if (error instanceof CodexConfigurationError) throw new ApiError(400, "CODEX_UNSUPPORTED_SETTINGS", error.message);
      throw error;
    }
    const settings = await service.updateSettings(body as Parameters<CodexAccountService["updateSettings"]>[0]);
    return c.json({ settings });
  });
  return app;
}
