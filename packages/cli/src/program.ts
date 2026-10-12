import { createRequire } from "node:module";
import { Command } from "commander";
import { projectRoot } from "./utils.js";
import { createInitCommand } from "./commands/init.js";
import { createUpCommand, createDownCommand, createDaemonCommand } from "./commands/daemon.js";
import { createStatusCommand } from "./commands/status.js";
import { createStudioCommand } from "./commands/studio.js";
import { createTuiCommand, openTui } from "./commands/tui.js";
import { createInteractCommand } from "./commands/interact.js";
import { createAgentCommand } from "./commands/agent.js";
import { createGoalCommand } from "./commands/goal.js";
import { createWorkCommand } from "./commands/work.js";
import { createWriteCommand } from "./commands/write.js";
import { createPublishingCommand } from "./commands/publishing.js";
import { createExportCommand } from "./commands/export.js";
import { createImportCommand } from "./commands/import.js";
import { createArtifactsCommand } from "./commands/artifacts.js";
import { createMaterialsCommand } from "./commands/materials.js";
import { createModelsCommand, createPluginsCommand } from "./commands/models.js";
import { createTasksCommand } from "./commands/tasks.js";
import { createConversationsCommand, createSubmissionsCommand } from "./commands/conversations.js";
import { createEventsCommand } from "./commands/events.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { updateCommand } from "./commands/update.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function createProgram(): Command {
  const program = new Command().name("inkos").description("InkOS — durable creative runtime CLI and TUI")
    .version(version).option("--project <path>", "Project root (defaults to cwd)")
    .option("--root <path>", "Alias for --project")
    .showHelpAfterError("Run 'inkos --help' for available commands.")
    .action((_options, command) => openTui(projectRoot(command)));
  for (const command of [
    createInitCommand(), createUpCommand(), createDownCommand(), createStatusCommand(), createDaemonCommand(),
    createStatusCommand("daemon-status"), createStudioCommand(), createTuiCommand(), createAgentCommand(), createInteractCommand(),
    createGoalCommand(), createWriteCommand(), createWorkCommand(), createTasksCommand(), createConversationsCommand(),
    createSubmissionsCommand(), createPublishingCommand(), createExportCommand(), createImportCommand(), createArtifactsCommand(),
    createMaterialsCommand(), createModelsCommand(), createPluginsCommand(), createEventsCommand(), createDoctorCommand(),
  ]) program.addCommand(command);
  program.addCommand(updateCommand);
  return program;
}

export async function runProgram(argv: string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}
