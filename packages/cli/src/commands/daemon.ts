import { realpath } from "node:fs/promises";
import { Command } from "commander";
import { RuntimeClient, findRuntime } from "../runtime.js";
import { ensureProjectDirectoryInitialized } from "../project-bootstrap.js";
import { output, projectRoot } from "../utils.js";
import { startBackgroundStudio, stopStudio, studioOptions } from "./studio.js";
import { createStatusCommand, showStatus } from "./status.js";

export function createUpCommand(name = "up"): Command {
  return studioOptions(new Command(name).description("Start or connect to the persistent project runtime, optionally start background Studio"))
    .option("--no-studio", "Start/connect runtime only").option("--json", "Output JSON")
    .action(async (options, command) => {
      const root = projectRoot(command);
      await ensureProjectDirectoryInitialized(root);
      const client = await RuntimeClient.connect(root);
      const { pid, rootDir, url } = client.endpoint;
      const studio = options.studio === false ? undefined : await startBackgroundStudio(rootDir, options);
      output({ pid, rootDir, url, ...(studio ? { studio } : {}) });
    });
}

export function createDownCommand(name = "down"): Command {
  return new Command(name).description("Explicitly stop this project's runtime and CLI-owned Studio; never signal a host service")
    .option("--json", "Output JSON")
    .action(async (_options, command) => {
      const rootDir = await realpath(projectRoot(command));
      const client = await findRuntime(rootDir);
      // Stop runtime even if Studio cleanup fails. Neither path sends process signals.
      let studio = false;
      try { studio = await stopStudio(rootDir); }
      finally { if (client) await client.stop(); }
      output({ rootDir, runtimeStopped: !!client, studioStopped: studio });
    });
}

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the shared background runtime (no CLI scheduler)")
    .option("--json", "Output JSON").action((options, command) => showStatus(command, options.json));
  daemon.addCommand(createUpCommand("start"));
  daemon.addCommand(createDownCommand("stop"));
  daemon.addCommand(createStatusCommand());
  return daemon;
}
