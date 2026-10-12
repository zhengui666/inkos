import { Command } from "commander";
import { connect, recordTaskExit, type NativeTask, type Work } from "../runtime.js";
import { nativeId, output } from "../utils.js";
import { planFromOptions, planOptions } from "../work-options.js";

export async function produce(command: Command, workId: string, options: { requestId?: string; wait?: boolean }): Promise<void> {
  const client = await connect(command);
  const started = await client.rpc<{ taskId: number }>("creation.produce", { workId, requestId: options.requestId });
  if (!options.wait) { output(started); return; }
  const task = await client.rpc<NativeTask>("tasks.wait", { id: started.taskId });
  recordTaskExit(task);
  output({ ...started, task });
}

export function createGoalCommand(): Command {
  const goal = new Command("goal").description("Inspect and control the Work's persistent plan, not a separate scheduler/goal ledger");
  goal.command("list").option("--json", "Output JSON").action(async (_options, command) => {
    output((await (await connect(command)).rpc<Work[]>("works.list")).map(({ id, title, plan }: Work) => ({ id, title, plan })));
  });
  goal.command("show").argument("<work-id>").option("--json", "Output JSON")
    .action(async (id: string, _options, command) => {
      const work = await (await connect(command)).rpc<Work>("works.get", { id });
      output({ id: work.id, title: work.title, plan: work.plan });
    });
  planOptions(goal.command("set").alias("create").argument("<work-id>"))
    .option("--json", "Output JSON").action(async (id: string, options, command) => {
      const plan = planFromOptions(options);
      if (!plan) throw new Error("Pass plan fields or --plan JSON.");
      output(await (await connect(command)).rpc("works.update", { id, changes: { plan } }));
    });
  goal.command("run").argument("<work-id>").option("--request-id <id>", "Idempotent request ID")
    .option("--wait", "Wait for the native task outcome").option("--json", "Output JSON")
    .action((workId: string, options, command) => produce(command, workId, options));
  for (const [name, paused] of [["pause", true], ["resume", false]] as const) {
    goal.command(name).argument("<work-id>").option("--json", "Output JSON")
      .action(async (id: string, _options, command) => output(await (await connect(command)).rpc("works.pause", { id, paused })));
  }
  goal.command("cancel").description("Native-abort a task; use goal pause <work-id> to pause production")
    .argument("<task-id>", "Native task ID", nativeId).option("--json", "Output JSON")
    .action(async (id: number, _options, command) => output(await (await connect(command)).rpc("tasks.abort", { id })));
  return goal;
}
