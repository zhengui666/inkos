import { basename } from "node:path";
import { render } from "ink";
import React from "react";
import { RuntimeClient, type ConversationRecord } from "../runtime.js";
import { ensureProjectDirectoryInitialized } from "../project-bootstrap.js";
import { InkTuiApp } from "./dashboard.js";
import { resolveTuiLocale } from "./i18n.js";

export async function launchTui(projectRoot: string, options: { conversationId?: number } = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The TUI needs a terminal. Use interact, status --json, or events for non-interactive clients.");
  await ensureProjectDirectoryInitialized(projectRoot);
  const client = await RuntimeClient.connect(projectRoot);
  const conversations: ConversationRecord[] = await client.rpc<ConversationRecord[]>("conversations.list");
  const conversationId = options.conversationId ?? conversations.filter(item => !item.owner).sort((a, b) => a.id - b.id).at(-1)?.id;
  const watch = new AbortController();
  const app = render(React.createElement(InkTuiApp, {
    client, projectName: basename(client.endpoint.rootDir), locale: resolveTuiLocale(),
    initialConversationId: conversationId, signal: watch.signal,
  }), { exitOnCtrlC: false });
  const detach = () => { watch.abort(); app.unmount(); };
  process.once("SIGTERM", detach);
  try { await app.waitUntilExit(); }
  finally { detach(); process.removeListener("SIGTERM", detach); }
  // Runtime is intentionally left running. Only `inkos down` stops the project service.
}
