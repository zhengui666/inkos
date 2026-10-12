import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Command, Option } from "commander";
import { connect } from "../runtime.js";
import { log, output } from "../utils.js";

type AuthPrompt = { type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
type LoginStatus = { status: "running" | "done" | "failed"; events: any[]; prompt?: AuthPrompt; error?: string };

async function ask(prompt: AuthPrompt): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Native model login needs an interactive terminal. Credentials are not accepted as CLI arguments.");
  if (prompt.options) for (const option of prompt.options) log(`${option.id}: ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  const hidden = prompt.type === "secret" || prompt.type === "manual_code";
  const sink = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const readline = createInterface({ input: process.stdin, output: sink, terminal: true, historySize: 0 });
  process.stdout.write(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
  try { return await readline.question(""); }
  finally { readline.close(); if (hidden) process.stdout.write("\n"); }
}

function showAuthEvent(event: any): void {
  switch (event.type) {
    case "auth_url": log(event.url); if (event.instructions) log(event.instructions); break;
    case "device_code": log(`${event.verificationUri} · code ${event.userCode}`); break;
    case "info":
    case "progress":
      if (event.message) log(event.message);
      for (const link of event.links ?? []) log(`${link.label ?? "Login"}: ${link.url}`);
      break;
  }
}

export function createModelsCommand(): Command {
  const models = new Command("models").description("Configure native SDK models and authentication through the runtime");
  models.command("list").option("--json", "Output JSON")
    .action(async (_options, command) => output(await (await connect(command)).rpc("models.list")));
  models.command("set").argument("<provider>").argument("<model-id>").option("--json", "Output JSON")
    .action(async (provider: string, modelId: string, _options, command) => output(await (await connect(command)).rpc("models.set", { provider, modelId })));
  models.command("logout").argument("<provider-id>").option("--json", "Output JSON")
    .action(async (providerId: string, _options, command) => output(await (await connect(command)).rpc("models.logout", { providerId })));
  models.command("login").argument("<provider-id>")
    .addOption(new Option("--type <type>", "Native login type").choices(["api_key", "oauth"]).default("api_key"))
    .action(async (providerId: string, options, command) => {
      const client = await connect(command);
      const { id } = await client.rpc<{ id: string }>("models.login.start", { providerId, type: options.type });
      let shown = 0;
      while (true) {
        const status = await client.rpc<LoginStatus>("models.login.status", { id });
        for (const event of status.events.slice(shown)) showAuthEvent(event);
        shown = status.events.length;
        if (status.status === "failed") throw new Error(status.error ?? "Native model login failed.");
        if (status.status === "done") { log(`Logged in to ${providerId}.`); return; }
        if (status.prompt) {
          const value = await ask(status.prompt);
          await client.rpc("models.login.respond", { id, value });
        }
        await delay(250);
      }
    });
  return models;
}

export function createPluginsCommand(): Command {
  const plugins = new Command("plugins").description("Inspect extension tools, tasks, profiles, and publishers");
  plugins.command("list").option("--json", "Output JSON")
    .action(async (_options, command) => output(await (await connect(command)).rpc("plugins.list")));
  plugins.command("configure").argument("[modules...]", "Extension module specifiers; no modules clears configuration")
    .option("--json", "Output JSON")
    .action(async (modules: string[], _options, command) => output(await (await connect(command)).rpc("plugins.configure", { modules })));
  return plugins;
}
