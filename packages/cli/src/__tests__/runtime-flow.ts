import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { RuntimeClient } from "@actalk/inkos-core";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
export async function tempProject(): Promise<string> {
  return realpath(await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "inkos-runtime-cli-")));
}

export async function runCli(root: string, args: string[], expectedExit = 0): Promise<any> {
  let stdout = "", stderr = "", code = 0;
  try {
    ({ stdout, stderr } = await execute(process.execPath, [cli, "--project", root, ...args, "--json"], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HOME: root, INKOS_TUI_LOCALE: "en" },
    }));
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    stdout = failed.stdout; stderr = failed.stderr; code = failed.code;
  }
  expect(code, `${stderr}\n${stdout}`).toBe(expectedExit);
  return JSON.parse(stdout);
}

export async function stopProject(root: string): Promise<void> {
  const client = await RuntimeClient.find(root);
  if (client) await client.stop();
  await expect.poll(() => RuntimeClient.find(root), { timeout: 10_000 }).toBeUndefined();
  await rm(root, { recursive: true, force: true });
}
