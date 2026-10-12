import { setTimeout as delay } from "node:timers/promises";
import { RuntimeClient, type RuntimeEvent } from "./runtime.js";

/** A read-only watch: losing the stream or closing the TUI never aborts native work. */
export async function watchRuntimeEvents(
  client: RuntimeClient,
  listener: (event: RuntimeEvent) => void,
  options: { conversationId?: number; signal: AbortSignal; onConnection?: (connected: boolean) => void; onClient?: (client: RuntimeClient) => void },
): Promise<void> {
  const root = client.endpoint.rootDir;
  while (!options.signal.aborted) {
    try {
      let received = false;
      await client.events((event: RuntimeEvent) => {
        if (!received) { received = true; options.onConnection?.(true); }
        listener(event);
      }, { conversationId: options.conversationId, signal: options.signal });
    } catch (error) {
      if (options.signal.aborted) return;
      options.onConnection?.(false);
    }
    if (options.signal.aborted) return;
    options.onConnection?.(false);
    try { await delay(500, undefined, { signal: options.signal }); }
    catch { return; }
    try { client = await RuntimeClient.connect(root, { start: false }); options.onClient?.(client); }
    catch { /* Wait for an explicitly restarted runtime, without starting it ourselves. */ }
  }
}
