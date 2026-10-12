import { realpath } from "node:fs/promises";
import { RuntimeClient } from "@actalk/inkos-core";
import type { Command } from "commander";
import { projectRoot } from "./utils.js";

export { RuntimeClient };
export * from "./runtime-view.js";

export async function connect(command: Command, start = true): Promise<RuntimeClient> {
  return RuntimeClient.connect(projectRoot(command), { start });
}

export async function findRuntime(root: string): Promise<RuntimeClient | undefined> {
  return RuntimeClient.find(await realpath(root));
}
