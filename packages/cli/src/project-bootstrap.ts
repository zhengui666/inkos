import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ProjectBootstrapOptions { readonly language?: string }

const ignored = [".env", "node_modules/", ".DS_Store", ".inkos/", ".inkos-runtime-start.log"];

export async function ensureProjectGitignore(projectDir: string): Promise<void> {
  const path = join(projectDir, ".gitignore");
  let existing = "";
  try { existing = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entries = new Set(existing.split(/\r?\n/).map(line => line.trim()));
  const missing = ignored.filter(entry => !entries.has(entry));
  if (missing.length) await writeFile(path, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

export async function initializeProjectDirectory(projectDir: string, options: ProjectBootstrapOptions = {}): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "inkos.json"), JSON.stringify({
    name: basename(projectDir), version: "2.0.0", language: options.language ?? "zh",
  }, null, 2) + "\n", { flag: "wx" });
  await mkdir(join(projectDir, ".inkos"), { recursive: true });
  await mkdir(join(projectDir, "works"), { recursive: true });
  await ensureProjectGitignore(projectDir);
}

export async function ensureProjectDirectoryInitialized(projectDir: string, options: ProjectBootstrapOptions = {}): Promise<boolean> {
  try { await access(join(projectDir, "inkos.json")); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await initializeProjectDirectory(projectDir, options); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}
