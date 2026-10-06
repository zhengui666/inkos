import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RadarResult } from "./radar.js";

/** Append-only scan history; repeating the same scan is safe but rewriting it is not. */
export async function persistRadarScan(projectRoot: string, result: RadarResult): Promise<{
  readonly path: string;
  readonly scanId: string;
  readonly result: RadarResult & { readonly scanId: string };
}> {
  const scanId = result.scanId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(scanId)) throw new Error("Radar scan ID is not a safe filename.");
  const saved = { ...result, scanId };
  const directory = join(projectRoot, "radar");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Radar history cannot be a symbolic link.");
  const path = join(directory, `scan-${scanId}.json`);
  const content = JSON.stringify(saved, null, 2) + "\n";
  const staging = await mkdtemp(join(directory, ".scan-staging-"));
  try {
    const temporary = join(staging, "scan.json");
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    // Hard-link promotion atomically exposes a complete file and cannot replace
    // an existing observation. A crash before this point leaves no partial scan.
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink() || await readFile(path, "utf8") !== content) {
        throw new Error(`Radar scan ${scanId} already exists with different content.`);
      }
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { path, scanId, result: saved };
}
