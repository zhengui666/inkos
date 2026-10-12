import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InvalidArgumentError, type Command } from "commander";

export function projectRoot(command: Command): string {
  const { project, root } = command.optsWithGlobals();
  if (project && root && resolve(project) !== resolve(root)) {
    throw new Error("--project and --root must refer to the same project.");
  }
  return resolve(project ?? root ?? process.cwd());
}

export function log(message: string): void { process.stdout.write(`${message}\n`); }
export function logError(message: string): void { process.stderr.write(`${message}\n`); }
export function output(value: unknown): void { log(JSON.stringify(value ?? null, null, 2)); }

export function jsonObject(value: string): Record<string, any> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidArgumentError("Expected a JSON object.");
  }
  return parsed;
}

export function integer(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
}

export function nativeId(value: string): number {
  const parsed = integer(value);
  if (!parsed) throw new InvalidArgumentError("Expected a positive native ID.");
  return parsed;
}

export function nullableNumber(value: string): number | null {
  if (value === "null") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new InvalidArgumentError("Expected a non-negative number or null.");
  return parsed;
}

export function timestamp(value: string): number | null {
  if (value === "null") return null;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError("Expected an ISO date, epoch milliseconds, or null.");
  return parsed;
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Pipe input or pass explicit text/file input.");
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

export async function readContent(options: { content?: string; file?: string; stdin?: boolean }): Promise<string | undefined> {
  if ([options.content !== undefined, options.file !== undefined, !!options.stdin].filter(Boolean).length > 1) {
    throw new Error("Use only one of --content, --file, or --stdin.");
  }
  if (options.file) return readFile(resolve(options.file), "utf8");
  if (options.stdin) return readStdin();
  return options.content;
}
