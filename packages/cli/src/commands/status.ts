import { Command } from "commander";
import { findRuntime, taskTree, type RuntimeStatus } from "../runtime.js";
import { log, output, projectRoot } from "../utils.js";

export async function showStatus(command: Command, json = false): Promise<void> {
  const rootDir = projectRoot(command);
  const client = await findRuntime(rootDir);
  if (!client) { output({ running: false, rootDir }); return; }
  const status = await client.rpc<RuntimeStatus>("status");
  if (json) { output(status); return; }
  log(`InkOS · ${status.rootDir} · runtime PID ${status.pid}`);
  log(`Works ${status.works.length} · targets ${status.targets.length} · distributions ${status.distributions.length} · tasks ${status.tasks.length}`);
  log(`Model: ${JSON.stringify(status.model)} · usage: ${JSON.stringify(status.usage)}`);
  for (const work of status.works) log(`${work.id} · ${work.profile} · ${work.title}`);
  for (const row of taskTree(status.taskGraph)) log(row);
}

export function createStatusCommand(name = "status"): Command {
  return new Command(name).description("Query runtime status without starting a service").option("--json", "Output raw runtime status")
    .action((_options, command) => showStatus(command, command.optsWithGlobals().json === true));
}
