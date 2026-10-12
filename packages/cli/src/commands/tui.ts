import { Command } from "commander";
import { nativeId, projectRoot } from "../utils.js";

export async function openTui(root: string, conversationId?: number): Promise<void> {
  const { launchTui } = await import("../tui/app.js");
  await launchTui(root, { conversationId });
}

export function createTuiCommand(): Command {
  return new Command("tui").description("Open the shared runtime chat and task-tree TUI")
    .option("--conversation <id>", "Open a persistent conversation", nativeId)
    .action((options, command) => openTui(projectRoot(command), options.conversation));
}
