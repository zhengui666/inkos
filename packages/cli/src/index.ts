#!/usr/bin/env node

import { runProgram } from "./program.js";
import { logError, output } from "./utils.js";

try { await runProgram(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) output({ error: message });
  else logError(message);
  process.exitCode = 1;
}
