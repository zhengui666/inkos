import { Command } from "commander";
import { connect } from "../runtime.js";
import { log, output, readContent } from "../utils.js";
import { createExportCommand } from "./export.js";

export function manuscriptOptions(command: Command): Command {
  return command.option("--artifact <id>", "Existing artifact ID").option("--revision <id>", "Source revision ID")
    .requiredOption("--title <text>", "Artifact title").option("--format <format>", "Manuscript format")
    .option("--content <text>", "Explicit imported manuscript or manual edit")
    .option("--file <path>", "Read manuscript from a file relative to cwd").option("--stdin", "Read manuscript from stdin")
    .option("--json", "Output JSON");
}

export async function saveManuscript(workId: string, options: any, command: Command): Promise<void> {
  const content = await readContent(options);
  if (content === undefined) throw new Error("Pass --content, --file, or --stdin. Saving never generates model content.");
  output(await (await connect(command)).rpc("artifacts.save", {
    workId, artifactId: options.artifact, revisionId: options.revision,
    title: options.title, content, format: options.format,
  }));
}

export function createArtifactsCommand(): Command {
  const artifacts = new Command("artifact").alias("artifacts").description("Read, import, manually edit, and export artifacts");
  artifacts.command("read").argument("<id>").option("--revision <id>", "Revision ID").option("--json", "Output full artifact and revision")
    .action(async (id: string, options, command) => {
      const result = await (await connect(command)).rpc<{ content: string }>("artifacts.read", { id, revisionId: options.revision });
      if (options.json) output(result); else log(result.content);
    });
  manuscriptOptions(artifacts.command("save").argument("<work-id>"))
    .action((workId: string, options, command) => saveManuscript(workId, options, command));
  artifacts.command("edit").argument("<id>").requiredOption("--target-text <text>", "Exact text to replace")
    .requiredOption("--replacement <text>", "Replacement text").option("--json", "Output JSON")
    .action(async (id: string, options, command) => output(await (await connect(command)).rpc("artifacts.edit", {
      id, targetText: options.targetText, replacement: options.replacement,
    })));
  artifacts.addCommand(createExportCommand());
  return artifacts;
}
