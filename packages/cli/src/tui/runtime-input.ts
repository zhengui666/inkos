import type { RuntimeClient } from "../runtime.js";
import type { SubmissionRecord } from "../runtime-view.js";
import { nativeId } from "../utils.js";

export const TUI_COMMANDS = ["/new [instructions]", "/conversations", "/use <conversation-id>", "/note <text>", "/status", "/works", "/tasks", "/write <work-id>", "/pause <task-id>", "/resume <task-id>", "/cancel <task-id>", "/work-pause <work-id>", "/work-resume <work-id>", "/abort", "/submission <id>", "/models", "/model <provider> <model-id>", "/busy <steer|followUp|reject>", "/help", "/quit"];
export type BusyPolicy = "steer" | "followUp" | "reject";
export type TuiInputResult = { conversationId?: number; output?: unknown; submission?: SubmissionRecord };

export async function submitTuiInput(
  client: Pick<RuntimeClient, "rpc">,
  input: string,
  options: { conversationId?: number; requestId: string; whenBusy?: BusyPolicy },
): Promise<TuiInputResult> {
  const match = input.match(/^(\/\S+)(?:\s+([\s\S]*))?$/);
  const command = match?.[1];
  const argument = match?.[2]?.trim() ?? "";
  const id = options.conversationId;
  switch (command) {
    case "/help": return { output: TUI_COMMANDS.join("\n") };
    case "/new": return { conversationId: (await client.rpc<{ id: number }>("conversations.create", { instructions: argument || undefined })).id };
    case "/use": {
      const conversationId = nativeId(argument);
      await client.rpc("conversations.get", { id: conversationId });
      return { conversationId };
    }
    case "/conversations": return { output: await client.rpc("conversations.list") };
    case "/status": return { output: await client.rpc("status") };
    case "/works": return { output: await client.rpc("works.list") };
    case "/tasks": return { output: await client.rpc("tasks.list") };
    case "/models": return { output: await client.rpc("models.list") };
    case "/model": {
      const [provider, modelId] = argument.split(/\s+/);
      if (!provider || !modelId) throw new Error("/model <provider> <model-id>; authenticate with inkos models login in a separate terminal.");
      return { output: await client.rpc("models.set", { provider, modelId }) };
    }
    case "/write":
      if (!argument) throw new Error("/write <work-id>");
      return { output: await client.rpc("creation.produce", { workId: argument, requestId: options.requestId }) };
    case "/work-pause":
    case "/work-resume":
      if (!argument) throw new Error(`${command} <work-id>`);
      return { output: await client.rpc("works.pause", { id: argument, paused: command === "/work-pause" }) };
    case "/pause":
    case "/resume": return { output: await client.rpc("tasks.pause", { id: nativeId(argument), paused: command === "/pause" }) };
    case "/cancel": return { output: await client.rpc("tasks.abort", { id: nativeId(argument) }) };
    case "/submission": return { output: await client.rpc("submissions.get", { id: nativeId(argument) }) };
    case "/abort":
      if (id === undefined) throw new Error("Select a conversation first: /use <id>.");
      return { output: await client.rpc("conversations.abort", { id }) };
    case "/note": if (!argument) throw new Error("/note <text>"); break;
    case undefined: break;
    default: throw new Error(`Unknown command ${command}. Use /help.`);
  }
  const conversationId = id ?? (await client.rpc<{ id: number }>("conversations.create")).id;
  const draft = command === "/note"
    ? { type: "write", requestId: options.requestId, entry: { kind: "inkos.note", data: { text: argument } } }
    : { type: "input", content: input, requestId: options.requestId, whenBusy: options.whenBusy ?? "followUp" };
  return { conversationId, submission: await client.rpc<SubmissionRecord>("conversations.submit", { id: conversationId, draft }) };
}
