import { Command } from "commander";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { log, logError } from "../utils.js";

function parseSemVer(version: string) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  const prerelease = match?.[4]?.split(".") ?? [];
  if (!match || match[0] !== version || prerelease.some((id) => /^[0-9]+$/.test(id) && id.length > 1 && id[0] === "0")) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  return { core: match.slice(1, 4), prerelease };
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemVer(leftVersion: string, rightVersion: string): number {
  const left = parseSemVer(leftVersion);
  const right = parseSemVer(rightVersion);
  for (let i = 0; i < 3; i++) {
    const result = compareDecimal(left.core[i]!, right.core[i]!);
    if (result) return result;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a);
    const bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return compareDecimal(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export const updateCommand = new Command("update")
  .description("Update InkOS to the latest version")
  .action(async () => {
    let targetVersion: string | undefined;
    try {
      const { version: currentVersion } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string };

      log(`Current version: ${currentVersion}`);
      parseSemVer(currentVersion);
      log("Checking npm registry...");

      const remoteVersion = execSync("npm view @actalk/inkos@latest version", {
        encoding: "utf-8",
      }).trim();
      const precedence = compareSemVer(currentVersion, remoteVersion);
      targetVersion = remoteVersion;

      if (precedence === 0) {
        log(`Already up to date (${currentVersion}).`);
        return;
      }

      if (precedence > 0) {
        const kind = parseSemVer(currentVersion).prerelease.length ? "development version" : "version";
        log(`You're running a newer ${kind} (${currentVersion} > ${remoteVersion}). Skipping.`);
        return;
      }

      log(`Updating: ${currentVersion} → ${remoteVersion}`);
      // Validated SemVer contains no shell metacharacters; the shell also supports Windows npm.cmd.
      execSync(`npm install -g @actalk/inkos@${remoteVersion}`, { stdio: "inherit" });
      const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
      if (!isAbsolute(globalRoot) || /[\r\n\0]/.test(globalRoot)) throw new Error("Invalid npm global root");
      const installed = JSON.parse(readFileSync(join(globalRoot, "@actalk", "inkos", "package.json"), "utf-8")) as { name?: string; version?: string } | null;
      if (installed?.name !== "@actalk/inkos" || installed?.version !== remoteVersion) {
        throw new Error(`Installed package mismatch: ${installed?.name ?? "missing name"}@${installed?.version ?? "missing version"}`);
      }
      log(`Updated to ${remoteVersion}.`);
    } catch (e) {
      logError(`Update failed${targetVersion ? ` (target @actalk/inkos@${targetVersion})` : ""}: ${e}`);
      log(targetVersion
        ? `You can also update manually: npm install -g @actalk/inkos@${targetVersion}`
        : "No valid target version was selected; check npm registry output before updating manually.");
      process.exit(1);
    }
  });
