import { Command } from "commander";
import { resolve } from "node:path";
import { initializeProjectDirectory } from "../project-bootstrap.js";
import { output, projectRoot } from "../utils.js";

export function createInitCommand(): Command {
  return new Command("init").description("Initialize a project without starting a runtime or configuring credentials")
    .argument("[directory]", "Directory relative to --project/--root or cwd")
    .option("--lang <locale>", "Default writing locale", "zh")
    .option("--json", "Output JSON")
    .action(async (directory: string | undefined, options, command) => {
      const rootDir = directory ? resolve(projectRoot(command), directory) : projectRoot(command);
      await initializeProjectDirectory(rootDir, { language: options.lang });
      output({ rootDir, initialized: true });
    });
}
