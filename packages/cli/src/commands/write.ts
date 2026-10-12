import { Command } from "commander";
import { connect, recordTaskExit, type NativeTask } from "../runtime.js";
import { output, readContent } from "../utils.js";
import { produce } from "./goal.js";

function startOptions(command: Command): Command {
  return command.option("--artifact <id>", "Existing artifact ID").option("--revision <id>", "Source revision ID")
    .option("--title <title>", "Artifact title").option("--instruction <text>", "Creative instruction")
    .option("--content <text>", "Explicit imported manuscript or manual edit (not a model script)")
    .option("--file <path>", "Read explicit manuscript from a file, relative to cwd")
    .option("--stdin", "Read explicit manuscript from stdin")
    .option("--request-id <id>", "Idempotent request ID").option("--wait", "Wait for native task outcome")
    .option("--json", "Output JSON");
}

async function start(workId: string, options: any, command: Command): Promise<void> {
  const content = await readContent(options);
  const client = await connect(command);
  const started = await client.rpc<{ taskId: number; artifactId: string }>("creation.start", {
    workId, artifactId: options.artifact, revisionId: options.revision, title: options.title,
    content, instruction: options.instruction, requestId: options.requestId,
  });
  if (!options.wait) { output(started); return; }
  const task = await client.rpc<NativeTask>("tasks.wait", { id: started.taskId });
  recordTaskExit(task);
  output({ ...started, task });
}

export function createWriteCommand(): Command {
  const write = startOptions(new Command("write").description("Start durable creation; exiting the CLI does not abort it")
    .argument("[work-id]"))
    .action(async (workId: string | undefined, options, command) => {
      if (!workId) { command.help(); return; }
      await start(workId, options, command);
    });
  startOptions(write.command("start").argument("<work-id>"))
    .action((workId: string, options, command) => start(workId, options, command));
  write.command("next").alias("produce").description("Produce from the saved Work plan")
    .argument("<work-id>").option("--request-id <id>", "Idempotent request ID")
    .option("--wait", "Wait for native task outcome").option("--json", "Output JSON")
    .action((workId: string, options, command) => produce(command, workId, options));
  return write;
}
