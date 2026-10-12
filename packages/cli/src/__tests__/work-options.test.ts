import { readFileSync } from "node:fs";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { mergePlan, planFromOptions, planOptions } from "../work-options.js";
import { nativeId, projectRoot, readContent } from "../utils.js";

async function parsePlan(args: string[]) {
  const command = planOptions(new Command());
  await command.parseAsync(args, { from: "user" });
  return planFromOptions(command.opts());
}

describe("runtime CLI parameters", () => {
  it("leaves omitted plan fields absent instead of overwriting saved goals", async () => {
    expect(await parsePlan([])).toBeUndefined();
    expect(await parsePlan(["--brief", "continue"])).toEqual({ brief: "continue" });
  });
  it("preserves zero, false, unbounded units, and explicit schedule removals", async () => {
    expect(await parsePlan(["--serial", "--units", "null", "--no-needs-planning", "--backlog", "0", "--cron", "null", "--next-at", "null"])).toEqual({
      serial: true, units: null, needsPlanning: false, production: { backlog: 0, cron: null, nextAt: null },
    });
    expect(await parsePlan(["--no-serial"])).toEqual({ serial: false });
  });
  it("merges nested production/review changes without losing existing policies", () => {
    expect(mergePlan({ serial: true, review: { enabled: true, maxRevisions: 3, maxCost: null }, production: { backlog: 5, cron: null, nextAt: 10 } },
      { review: { enabled: false }, production: { backlog: 0 } })).toEqual({
      serial: true, review: { enabled: false, maxRevisions: 3, maxCost: null }, production: { backlog: 0, cron: null, nextAt: 10 },
    });
  });
  it("accepts global root options before or after nested command names", async () => {
    for (const args of [["--project", "one", "work", "show"], ["work", "show", "--root", "one"]]) {
      let root: string | undefined;
      const program = new Command().option("--project <path>").option("--root <path>");
      program.command("work").command("show").action((_options, command) => { root = projectRoot(command); });
      await program.parseAsync(args, { from: "user" });
      expect(root).toBe(`${process.cwd()}/one`);
    }
  });
  it("preserves empty explicit edits and rejects mixed manuscript inputs", async () => {
    expect(await readContent({ content: "" })).toBe("");
    await expect(readContent({ content: "text", file: "elsewhere" })).rejects.toThrow("only one");
    expect(nativeId("12")).toBe(12);
    expect(() => nativeId("12trailing")).toThrow();
  });
  it("packages native runtime requirements and keeps only used runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.engines.node).toBe(">=22.19.0");
    expect(manifest.dependencies.ink).toBeTruthy();
    expect(manifest.dependencies.react).toBeTruthy();
    expect(manifest.dependencies["epub-gen-memory"]).toBeUndefined();
    expect(manifest.dependencies.dotenv).toBeUndefined();
    expect(manifest.overrides).toBeUndefined();
  });
});
