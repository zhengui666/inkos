/**
 * postpack hook — restores original package.json from backup.
 *
 * Shared by all publishable packages. Invoked as:
 *   "postpack": "node ../../scripts/restore-package-json.mjs"
 */

import { readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, "package.json");
const backupPath = join(packageDir, ".package.json.publish-backup");

async function writeAtomic(path, content) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

async function main() {
  let original;
  try {
    original = await readFile(backupPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      // No backup means prepack found nothing to replace — fine.
      return;
    }
    throw error;
  }
  await writeAtomic(packageJsonPath, original);
  await rm(backupPath);
}

await main();
