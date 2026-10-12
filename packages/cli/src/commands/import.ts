import { Command } from "commander";
import { manuscriptOptions, saveManuscript } from "./artifacts.js";

export function createImportCommand(): Command {
  return manuscriptOptions(new Command("import").description("Save an explicit manuscript without a model call").argument("<work-id>"))
    .action((workId: string, options, command) => saveManuscript(workId, options, command));
}
