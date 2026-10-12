import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { RuntimeClient } from "../runtime.js";
import { ensureProjectDirectoryInitialized } from "../project-bootstrap.js";
import { integer, logError, output, projectRoot } from "../utils.js";

export type StudioOptions = { port?: number; host?: string };
type StudioEndpoint = { pid: number; rootDir: string; url: string; controlUrl: string; token: string };
const endpointPath = (root: string) => join(root, ".inkos", "cli-studio.json");
const publicEndpoint = ({ pid, rootDir, url }: StudioEndpoint) => ({ pid, rootDir, url });

export async function findStudio(root: string): Promise<StudioEndpoint | undefined> {
  let endpoint: StudioEndpoint;
  try { endpoint = JSON.parse(await readFile(endpointPath(root), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (endpoint.rootDir !== root) return undefined;
  try {
    const response = await fetch(endpoint.controlUrl, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1000) });
    const active = await response.json() as { pid: number; rootDir: string };
    if (response.ok && active.pid === endpoint.pid && active.rootDir === root) return endpoint;
  } catch { /* The recorded CLI Studio is no longer serving. Never signal its old PID. */ }
  return undefined;
}

export async function stopStudio(root: string): Promise<boolean> {
  const studio = await findStudio(root);
  if (!studio) return false;
  const response = await fetch(studio.controlUrl, { method: "POST", headers: { authorization: `Bearer ${studio.token}` } });
  if (!response.ok) throw new Error("Could not stop the project's CLI Studio.");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await findStudio(root)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The project's Studio is still closing; its endpoint was retained.");
}

/** This control endpoint only closes the Studio started by this CLI, never a host service by PID. */
export async function serveStudio(root: string, options: StudioOptions): Promise<void> {
  const client = await RuntimeClient.connect(root);
  root = client.endpoint.rootDir;
  const existing = await findStudio(root);
  if (existing) { output({ studio: publicEndpoint(existing) }); process.send?.({ studio: publicEndpoint(existing) }); return; }
  const { startStudio } = await import("@actalk/inkos-studio");
  const studio = await startStudio(root, options);
  let endpoint: StudioEndpoint;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await studio.close();
    await new Promise<void>((resolve, reject) => control.close(error => error ? reject(error) : resolve()));
    try {
      const recorded = JSON.parse(await readFile(endpointPath(root), "utf8"));
      if (recorded.token === endpoint.token) await unlink(endpointPath(root));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const onSignal = () => { void shutdown().catch(error => { logError(String(error)); process.exitCode = 1; }); };
  const token = randomUUID();
  const control = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") response.end(JSON.stringify(publicEndpoint(endpoint)));
    else if (request.method === "POST") { response.end(JSON.stringify({ stopping: true })); onSignal(); }
    else response.writeHead(405).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
    const address = control.address() as { port: number };
    endpoint = { pid: process.pid, rootDir: root, url: studio.url, token, controlUrl: `http://127.0.0.1:${address.port}` };
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(endpointPath(root), JSON.stringify(endpoint), { mode: 0o600 });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    output({ studio: publicEndpoint(endpoint) });
    process.send?.({ studio: publicEndpoint(endpoint) });
  } catch (error) {
    control.close();
    await studio.close();
    throw error;
  }
}

export async function startBackgroundStudio(root: string, options: StudioOptions): Promise<{ pid: number; rootDir: string; url: string }> {
  const existing = await findStudio(root);
  if (existing) return publicEndpoint(existing);
  const logPath = join(root, ".inkos", "cli-studio.log");
  const log = await open(logPath, "a", 0o600);
  const args = [fileURLToPath(new URL("../index.js", import.meta.url)), "--project", root, "studio"];
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.host !== undefined) args.push("--host", options.host);
  let child;
  try {
    child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"], env: process.env });
  } finally { await log.close(); }
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Studio did not start; see ${logPath}. Runtime remains running.`)); }, 20_000);
      const cleanup = () => { clearTimeout(timer); child.removeListener("message", onMessage); child.removeListener("error", onError); child.removeListener("exit", onExit); };
      const onMessage = (message: any) => {
        if (message.studio) { cleanup(); resolve(message.studio); }
        else if (message.error) { cleanup(); reject(new Error(message.error)); }
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number | null) => { cleanup(); reject(new Error(`Studio exited (${code}); see ${logPath}. Runtime remains running.`)); };
      child.on("message", onMessage); child.once("error", onError); child.once("exit", onExit);
    });
  } finally { if (child.connected) child.disconnect(); child.unref(); }
}

export function studioOptions(command: Command): Command {
  return command.option("--port <number>", "Studio port (0 chooses a free port)", integer, 4567)
    .option("--host <host>", "Studio bind host", "127.0.0.1");
}

export function createStudioCommand(): Command {
  return studioOptions(new Command("studio").description("Run Studio in the foreground, connected to the independent runtime"))
    .action(async (options, command) => {
      const root = projectRoot(command);
      await ensureProjectDirectoryInitialized(root);
      try { await serveStudio(root, options); }
      catch (error) { process.send?.({ error: error instanceof Error ? error.message : String(error) }); throw error; }
    });
}
