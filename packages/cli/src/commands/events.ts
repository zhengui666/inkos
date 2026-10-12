import { Command } from "commander";
import { connect } from "../runtime.js";
import { watchRuntimeEvents } from "../events.js";
import { log, nativeId } from "../utils.js";

export function createEventsCommand(): Command {
  return new Command("events").description("Watch runtime SSE as JSON lines; Ctrl-C only detaches this watch")
    .option("--conversation <id>", "Watch this conversation's native agent events", nativeId)
    .action(async (options, command) => {
      const client = await connect(command);
      const watch = new AbortController();
      const detach = () => watch.abort();
      process.once("SIGINT", detach); process.once("SIGTERM", detach);
      try { await watchRuntimeEvents(client, event => log(JSON.stringify(event)), { conversationId: options.conversation, signal: watch.signal }); }
      finally { detach(); process.removeListener("SIGINT", detach); process.removeListener("SIGTERM", detach); }
    });
}
