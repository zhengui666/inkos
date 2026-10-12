import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import { connect, conversationMessages, type ConversationView, type SubmissionRecord, type Work } from "../runtime.js";
import { jsonObject, log, nativeId, output, readContent, readStdin } from "../utils.js";

export function createInteractCommand(name = "interact"): Command {
  return new Command(name).description("Submit to a persistent native conversation; reconnecting never resubmits input")
    .argument("[message...]").option("--message <text>", "Explicit message")
    .option("--file <path>", "Read message from a file").option("--stdin", "Read message from stdin")
    .option("--conversation <id>", "Reuse native conversation ID", nativeId)
    .option("--session <id>", "Alias for --conversation", nativeId)
    .option("--work <id>", "Include Work context in this interaction")
    .option("--instructions <text>", "Instructions for a new conversation")
    .option("--model <json>", "Native model reference for a new conversation", jsonObject)
    .option("--request-id <id>", "Idempotent request ID, scoped to this conversation")
    .addOption(new Option("--when-busy <policy>", "Native busy-input policy").choices(["steer", "followUp", "reject"]))
    .option("--note", "Passive inkos.note write (no model call)").option("--no-wait", "Return the admitted submission immediately")
    .option("--json", "Output native submission and conversation view")
    .action(async (messages: string[], options, command) => {
      let content = await readContent({ ...options, content: options.message ?? (messages.length ? messages.join(" ") : undefined) });
      if (content === undefined && !process.stdin.isTTY) content = await readStdin();
      if (!content?.trim()) throw new Error("Pass message text, --message, --file, or piped input.");
      if (options.conversation && options.session && options.conversation !== options.session) throw new Error("--conversation and --session must match.");
      const client = await connect(command);
      let instructions = options.instructions;
      if (options.work) {
        const work = await client.rpc<Work>("works.get", { id: options.work });
        const context = `Work context: ${work.id} (${work.title}), profile ${work.profile}.`;
        instructions = [instructions, context].filter(Boolean).join("\n");
        if (options.conversation ?? options.session) content = `${context}\n\n${content}`;
      }
      const id = options.conversation ?? options.session ?? (await client.rpc<{ id: number }>("conversations.create", { instructions, model: options.model })).id;
      const requestId = options.requestId ?? randomUUID();
      const draft = options.note
        ? { type: "write", requestId, entry: { kind: "inkos.note", data: { text: content } } }
        : { type: "input", content, requestId, whenBusy: options.whenBusy };
      const admitted = await client.rpc<SubmissionRecord>("conversations.submit", { id, draft });
      const submission = options.wait === false ? admitted : await client.rpc<SubmissionRecord>("submissions.wait", { id: admitted.id });
      if (submission.status === "unanswered") process.exitCode = 1;
      if (options.wait === false) { output({ conversationId: id, requestId, submission }); return; }
      const conversation = await client.rpc<ConversationView>("conversations.get", { id });
      if (options.json) output({ conversationId: id, requestId, submission, conversation });
      else {
        log(`Conversation ${id} · submission ${submission.id} · ${submission.status} · request ${requestId}`);
        if (options.note) log(content);
        else log(conversationMessages(conversation).filter(message => message.role === "assistant").at(-1)?.content ?? submission.reason ?? "");
      }
    });
}
