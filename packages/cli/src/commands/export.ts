import { Command, Option } from "commander";
import { connect } from "../runtime.js";
import { log, output } from "../utils.js";

export function createExportCommand(name = "export"): Command {
  return new Command(name).description("Export an artifact using the runtime's canonical revision")
    .argument("<artifact-id>")
    .addOption(new Option("--format <format>", "Export format").choices(["txt", "md", "epub", "html", "json", "ink"]).default("txt"))
    .option("--json", "Output JSON metadata")
    .action(async (artifactId: string, options, command) => {
      const result = await (await connect(command)).rpc<{ path: string }>("artifacts.export", { artifactId, format: options.format });
      if (options.json) output(result); else log(result.path);
    });
}
