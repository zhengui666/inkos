import { Command } from "commander";
import { resolve } from "node:path";
import { connect } from "../runtime.js";
import { integer, output } from "../utils.js";

export function createMaterialsCommand(): Command {
  const materials = new Command("materials").alias("material").description("Ingest and query project reference materials");
  materials.command("ingest").option("--file <path>", "Local material file, relative to cwd")
    .option("--url <url>", "Remote material URL").option("--title <text>", "Material title")
    .option("--purpose <text>", "Intended purpose").option("--json", "Output JSON")
    .action(async (options, command) => {
      if (!!options.file === !!options.url) throw new Error("Pass either --file or --url.");
      output(await (await connect(command)).rpc("materials.ingest", {
        sourceKind: options.file ? "file" : "url", filePath: options.file ? resolve(options.file) : undefined,
        url: options.url, title: options.title, purpose: options.purpose,
      }));
    });
  materials.command("query").argument("<query>").option("--limit <number>", "Maximum results", integer)
    .option("--purpose <text>", "Filter by purpose").option("--json", "Output JSON")
    .action(async (query: string, options, command) => output(await (await connect(command)).rpc("materials.query", { query, limit: options.limit, purpose: options.purpose })));
  materials.command("list").option("--json", "Output JSON")
    .action(async (_options, command) => output(await (await connect(command)).rpc("materials.list")));
  return materials;
}
