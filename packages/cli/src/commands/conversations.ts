import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { connect } from "../runtime.js";
import { jsonObject, nativeId, output } from "../utils.js";

export function createConversationsCommand(): Command {
  const conversations = new Command("conversations").description("Inspect native persistent conversations and their inbox, usage, and agent documents");
  conversations.command("list").option("--json", "Output JSON")
    .action(async (_options, command) => output(await (await connect(command)).rpc("conversations.list")));
  conversations.command("create").option("--instructions <text>", "Conversation instructions")
    .option("--model <json>", "Native model reference", jsonObject).option("--json", "Output JSON")
    .action(async (options, command) => output(await (await connect(command)).rpc("conversations.create", { instructions: options.instructions, model: options.model })));
  for (const [name, method] of [["show", "conversations.get"], ["abort", "conversations.abort"]] as const) {
    conversations.command(name).argument("<id>", "Native conversation ID", nativeId).option("--json", "Output JSON")
      .action(async (id: number, _options, command) => output(await (await connect(command)).rpc(method, { id })));
  }
  conversations.command("configure").argument("<id>", "Native conversation ID", nativeId)
    .requiredOption("--changes <json>", "Native conversation configuration", jsonObject).option("--json", "Output JSON")
    .action(async (id: number, options, command) => output(await (await connect(command)).rpc("conversations.configure", { id, changes: options.changes })));
  conversations.command("note").argument("<id>", "Native conversation ID", nativeId).argument("<text>")
    .option("--request-id <id>", "Idempotent request ID").option("--json", "Output JSON")
    .action(async (id: number, text: string, options, command) => output(await (await connect(command)).rpc("conversations.submit", {
      id, draft: { type: "write", requestId: options.requestId ?? randomUUID(), entry: { kind: "inkos.note", data: { text } } },
    })));
  return conversations;
}

export function createSubmissionsCommand(): Command {
  const submissions = new Command("submissions").description("Inspect, wait for, or explicitly abort a native submission");
  for (const [name, method] of [["show", "submissions.get"], ["wait", "submissions.wait"], ["abort", "submissions.abort"]] as const) {
    submissions.command(name).argument("<id>", "Native submission ID", nativeId).option("--json", "Output JSON")
      .action(async (id: number, _options, command) => {
        const result = await (await connect(command)).rpc(method, { id });
        if (name === "wait" && result.status === "unanswered") process.exitCode = 1;
        output(result);
      });
  }
  return submissions;
}
