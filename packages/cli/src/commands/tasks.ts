import { Command } from "commander";
import { connect, recordTaskExit, taskTree, type NativeTask, type RuntimeStatus } from "../runtime.js";
import { log, nativeId, output } from "../utils.js";

export function createTasksCommand(): Command {
  const tasks = new Command("tasks").description("Inspect durable tasks; pause is domain pause, cancel is native abort");
  tasks.command("list").option("--json", "Output JSON")
    .action(async (_options, command) => output(await (await connect(command)).rpc("tasks.list")));
  tasks.command("tree").option("--json", "Output raw native task graph")
    .action(async (options, command) => {
      const { taskGraph } = await (await connect(command)).rpc<RuntimeStatus>("status");
      if (options.json) output(taskGraph); else log(taskTree(taskGraph).join("\n") || "No live tasks.");
    });
  for (const [name, method] of [["show", "tasks.get"], ["cancel", "tasks.abort"], ["wait", "tasks.wait"]] as const) {
    const sub = tasks.command(name).argument("<id>", "Native task ID", nativeId).option("--json", "Output JSON");
    if (name === "cancel") sub.alias("abort");
    sub.action(async (id: number, _options, command) => {
      const task = await (await connect(command)).rpc<NativeTask>(method, { id });
      if (name === "wait") recordTaskExit(task);
      output(task);
    });
  }
  for (const [name, paused] of [["pause", true], ["resume", false]] as const) {
    tasks.command(name).argument("<id>", "Native task ID", nativeId).option("--json", "Output JSON")
      .action(async (id: number, _options, command) => output(await (await connect(command)).rpc("tasks.pause", { id, paused })));
  }
  return tasks;
}
