import { Command, InvalidArgumentError, Option } from "commander";
import { connect } from "../runtime.js";
import { jsonObject, output, timestamp } from "../utils.js";

export function createPublishingCommand(): Command {
  const publishing = new Command("publishing").description("Manage independent publishing targets and durable distributions");
  for (const [name, method] of [["targets", "publishing.targets"], ["list", "publishing.list"]] as const) {
    publishing.command(name).option("--json", "Output JSON")
      .action(async (_options, command) => output(await (await connect(command)).rpc(method)));
  }
  publishing.command("create-target").argument("[id]").requiredOption("--work <id>", "Work ID")
    .requiredOption("--publisher <id>", "meganovel, browser, or extension publisher ID")
    .requiredOption("--account-id <id>", "Account ID").requiredOption("--account-label <label>", "Account label")
    .option("--remote-work <id>", "Existing remote Work ID").option("--browser <json>", "Browser settings", jsonObject)
    .option("--metadata <json>", "Publisher metadata", jsonObject).option("--skill <id>", "Publisher skill")
    .option("--json", "Output JSON")
    .action(async (id: string | undefined, options, command) => output(await (await connect(command)).rpc("publishing.createTarget", {
      id, workId: options.work, publisher: options.publisher, accountId: options.accountId, accountLabel: options.accountLabel,
      remoteWorkId: options.remoteWork, browser: options.browser, metadata: options.metadata, skill: options.skill,
    })));
  publishing.command("update-target").argument("<id>").requiredOption("--changes <json>", "Target changes", jsonObject)
    .option("--json", "Output JSON")
    .action(async (id: string, options, command) => output(await (await connect(command)).rpc("publishing.updateTarget", { id, changes: options.changes })));
  publishing.command("queue").argument("<target-id>").argument("<artifact-id>")
    .option("--revision <id>", "Revision ID")
    .addOption(new Option("--operation <operation>", "Distribution operation").choices(["publish", "update"]))
    .option("--scheduled-at <time>", "ISO date or epoch milliseconds", value => {
      const parsed = timestamp(value);
      if (parsed === null) throw new InvalidArgumentError("Omit --scheduled-at for immediate publication.");
      return parsed;
    })
    .option("--request-id <id>", "Idempotent request ID").option("--json", "Output JSON")
    .action(async (targetId: string, artifactId: string, options, command) => output(await (await connect(command)).rpc("publishing.queue", {
      targetId, artifactId, revisionId: options.revision, operation: options.operation, scheduledAt: options.scheduledAt, requestId: options.requestId,
    })));
  for (const method of ["resume", "observe"]) {
    publishing.command(method).argument("<id>", "Distribution ID").option("--json", "Output JSON")
      .action(async (id: string, _options, command) => output(await (await connect(command)).rpc(`publishing.${method}`, { id })));
  }
  return publishing;
}
