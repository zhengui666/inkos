import { expect, it } from "vitest";
import { deriveInvalidationPaths } from "./use-api.js";
it.each(["/codex/login", "/codex/login/cancel", "/codex/logout", "/codex/settings"])("refreshes account/settings/health consumers after %s", path => {
  expect(deriveInvalidationPaths(path)).toEqual(["/api/v1/codex/account", "/api/v1/codex/settings", "/api/v1/codex/models", "/api/v1/doctor"]);
});
