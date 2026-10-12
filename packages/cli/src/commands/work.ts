import { Command } from "commander";
import { connect, type Work } from "../runtime.js";
import { jsonObject, output } from "../utils.js";
import { mergePlan, planFromOptions, planOptions } from "../work-options.js";

function fields(command: Command): Command {
  return planOptions(command.option("--title <text>", "Work title")
    .option("--profile <id>", "Built-in or extension profile (no platform required)")
    .option("--locale <locale>", "Writing locale")
    .option("--domain <json>", "Profile-specific domain data", jsonObject))
    .option("--json", "Output JSON");
}

export function createWorkCommand(): Command {
  const work = new Command("work").description("Manage Works and persistent production plans through the runtime");
  work.command("list").option("--profile <id>", "Filter by profile").option("--json", "Output JSON")
    .action(async (options, command) => {
      const works: Work[] = await (await connect(command)).rpc<Work[]>("works.list");
      output(options.profile ? works.filter(item => item.profile === options.profile) : works);
    });
  fields(work.command("create").argument("[title]").option("--id <id>", "Work ID"))
    .action(async (title: string | undefined, options, command) => {
      title = options.title ?? title;
      if (!title?.trim()) throw new Error("Pass a title or --title.");
      output(await (await connect(command)).rpc("works.create", {
        id: options.id, title, profile: options.profile, locale: options.locale, brief: options.brief,
        plan: planFromOptions(options), domain: options.domain,
      }));
    });
  work.command("show").argument("<id>").option("--json", "Output JSON")
    .action(async (id: string, _options, command) => output(await (await connect(command)).rpc("works.get", { id })));
  fields(work.command("update").argument("<id>").option("--changes <json>", "Work changes JSON", jsonObject))
    .action(async (id: string, options, command) => {
      const client = await connect(command);
      const changes = { ...options.changes };
      for (const key of ["title", "profile", "locale", "brief", "domain"]) {
        if (options[key] !== undefined) changes[key] = options[key];
      }
      const plan = planFromOptions({ ...options, plan: mergePlan(changes.plan ?? {}, options.plan ?? {}) });
      if (plan) changes.plan = plan; // Only explicit changes; the runtime owns persisted-state merging.
      if (!Object.keys(changes).length) throw new Error("Pass Work fields, --plan, or --changes.");
      output(await client.rpc("works.update", { id, changes }));
    });
  for (const [name, paused] of [["pause", true], ["resume", false]] as const) {
    work.command(name).argument("<id>").option("--json", "Output JSON")
      .action(async (id: string, _options, command) => output(await (await connect(command)).rpc("works.pause", { id, paused })));
  }
  work.command("migrate").description("Preview legacy migration by default; --apply retains original data")
    .option("--source <path>", "Legacy source directory").option("--apply", "Apply migration")
    .option("--json", "Output JSON")
    .action(async (options, command) => output(await (await connect(command)).rpc("work.migrate", { source: options.source, apply: options.apply === true })));
  return work;
}
