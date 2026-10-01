import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** CI builds the whole workspace first. Test those immutable assets, rather
 * than cleaning core/dist in globalSetup while Vite is already importing it. */
export default defineConfig({
  ...base,
  globalSetup: undefined,
  use: { ...base.use, baseURL: "http://127.0.0.1:4580" },
  webServer: {
    command: "node dist/api/index.js",
    env: { INKOS_STUDIO_PORT: "4580", INKOS_PROJECT_ROOT: "../../test-project" },
    url: "http://127.0.0.1:4580",
    reuseExistingServer: false,
    timeout: 30_000,
    cwd: ".",
  },
});
