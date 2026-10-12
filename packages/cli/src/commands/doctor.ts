import { Command } from "commander";
import { findRuntime } from "../runtime.js";
import { output, projectRoot } from "../utils.js";

export function createDoctorCommand(): Command {
  return new Command("doctor").description("Show local runtime and model configuration; never makes a model or site request")
    .option("--json", "Output JSON").action(async (_options, command) => {
      const rootDir = projectRoot(command);
      const client = await findRuntime(rootDir);
      output({ node: process.version, requiredNode: ">=22.19.0", rootDir, running: !!client,
        ...(client ? { pid: client.endpoint.pid, models: await client.rpc("models.list"), plugins: await client.rpc("plugins.list") } : {}),
      });
    });
}
