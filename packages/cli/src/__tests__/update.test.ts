import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  current: "2.0.0-dev.1",
  remote: "2.0.0\n",
  installed: JSON.stringify({ name: "@actalk/inkos", version: "2.0.0" }),
  exec: vi.fn(),
  read: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  exit: new Error("fixture exit"),
}));

vi.mock("node:child_process", () => ({ execSync: fixture.exec }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: fixture.read,
}));
// Keep the frozen updater's package read isolated during the RED run as well.
vi.mock("node:module", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:module")>(),
  createRequire: () => () => ({ version: fixture.current }),
}));
vi.mock("../utils.js", () => ({ log: fixture.log, logError: fixture.error }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture.current = "2.0.0-dev.1";
  fixture.remote = "2.0.0\n";
  fixture.installed = JSON.stringify({ name: "@actalk/inkos", version: "2.0.0" });
  fixture.exec.mockImplementation((command: string) => {
    if (command.startsWith("npm view ")) return fixture.remote;
    if (command.startsWith("npm install ")) return "";
    if (command === "npm root -g") return "/fixture-global\n";
    throw new Error(`Unexpected npm command: ${command}`);
  });
  fixture.read.mockImplementation((path: URL | string) => {
    if (path instanceof URL) return JSON.stringify({ version: fixture.current });
    if (path === join("/fixture-global", "@actalk", "inkos", "package.json")) return fixture.installed;
    throw new Error(`Unexpected manifest: ${path}`);
  });
  vi.spyOn(process, "exit").mockImplementation(() => { throw fixture.exit; });
});

afterEach(() => { vi.restoreAllMocks(); });

async function runUpdate() {
  const { updateCommand } = await import("../commands/update.js");
  await updateCommand.parseAsync(["node", "inkos"]);
}

function commands(): string[] { return fixture.exec.mock.calls.map(([command]) => command); }
function installs() { return commands().filter((command) => command.startsWith("npm install ")); }
function output() { return fixture.log.mock.calls.map(([line]) => line).join("\n"); }

describe("update action", () => {
  it.each([
    ["2.0.1-dev.1", "2.0.0", "newer development version"],
    ["2.0.0", "2.0.0-canary.3", "newer version"],
    ["2.0.0", "2.0.0", "Already up to date"],
    ["2.0.0+local.1", "2.0.0+remote.2", "Already up to date"],
    ["2.0.0-dev.1+local", "2.0.0-dev.1+remote", "Already up to date"],
  ])("skips %s against latest %s", async (current, remote, message) => {
    fixture.current = current;
    fixture.remote = remote;
    await runUpdate();
    expect(installs()).toEqual([]);
    expect(commands()).toEqual(["npm view @actalk/inkos@latest version"]);
    expect(output()).toContain(`Current version: ${current}`);
    expect(output()).toContain(message);
    expect(output()).not.toContain("Updated to");
  });

  it("installs stable over its prerelease and confirms the owning manifest", async () => {
    await runUpdate();
    expect(commands()).toEqual([
      "npm view @actalk/inkos@latest version",
      "npm install -g @actalk/inkos@2.0.0",
      "npm root -g",
    ]);
    expect(fixture.read).toHaveBeenLastCalledWith(join("/fixture-global", "@actalk", "inkos", "package.json"), "utf-8");
    expect(output()).toContain("Updated to 2.0.0.");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("keeps the selected version when latest drifts after the query", async () => {
    fixture.exec.mockImplementation((command: string) => {
      if (command.startsWith("npm view ")) {
        const selected = fixture.remote;
        fixture.remote = "2.1.0";
        return selected;
      }
      if (command === "npm root -g") return "/fixture-global\n";
      return "";
    });
    await runUpdate();
    expect(installs()).toEqual(["npm install -g @actalk/inkos@2.0.0"]);
    expect(commands().filter((command) => command.startsWith("npm view "))).toHaveLength(1);
    expect(output()).toContain("Updated to 2.0.0.");
    expect(output()).not.toContain("Updated to 2.1.0");
  });

  it.each(["", " \n", "2.0", "v2.0.0", "02.0.0", "2.0.0-dev.01", "2.0.0\n2.1.0", '["2.0.0","2.1.0"]',
    "2.0.0; touch /tmp/injected", "2.0.0 && echo injected", "2.0.0 --prefix=/tmp/other", "2.0.0$(echo injected)", "2.0.0\0"])(
    "rejects registry output %j before install", async (remote) => {
      fixture.remote = remote;
      await expect(runUpdate()).rejects.toBe(fixture.exit);
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(installs()).toEqual([]);
      expect(output()).not.toContain("Updated to");
      expect(output()).not.toContain("npm install -g @actalk/inkos@latest");
    },
  );

  it("rejects an invalid current version without querying npm", async () => {
    fixture.current = "2.0.0-dev.01";
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(commands()).toEqual([]);
  });

  it("fails a registry error without claiming a selected version", async () => {
    fixture.exec.mockImplementation(() => { throw new Error("registry unavailable"); });
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(installs()).toEqual([]);
    expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining("registry unavailable"));
    expect(output()).toContain("No valid target version");
  });

  it("does not read back or report success after install throws", async () => {
    fixture.exec.mockImplementation((command: string) => {
      if (command.startsWith("npm view ")) return fixture.remote;
      throw new Error("install failed");
    });
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(commands()).toHaveLength(2);
    expect(output()).not.toContain("Updated to");
    expect(output()).toContain("npm install -g @actalk/inkos@2.0.0");
    expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining("@actalk/inkos@2.0.0"));
  });

  it.each([
    ['{"name":"@actalk/inkos","version":"2.1.0"}', "2.1.0"],
    ['{"name":"@actalk/inkos","version":"2.0.0+other"}', "2.0.0+other"],
    ['{"name":"other-package","version":"2.0.0"}', "other-package"],
    ['{"name":"@actalk/inkos"}', "missing"],
    ["{}", "missing"],
    ["null", "missing"],
    ["not JSON", "SyntaxError"],
  ])("fails installed manifest %s without a false success", async (installed, detail) => {
    fixture.installed = installed;
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(installs()).toHaveLength(1);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(output()).not.toContain("Updated to");
    expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining(detail));
    expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining("@actalk/inkos@2.0.0"));
  });

  it("fails a missing owning manifest", async () => {
    fixture.read.mockImplementation((path: URL | string) => {
      if (path instanceof URL) return JSON.stringify({ version: fixture.current });
      throw new Error("ENOENT missing package");
    });
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(output()).not.toContain("Updated to");
    expect(installs()).toHaveLength(1);
  });

  it.each(["", "relative-root", "/one\n/two"])("rejects invalid npm global root %j", async (root) => {
    fixture.exec.mockImplementation((command: string) => command.startsWith("npm view ") ? fixture.remote : root);
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(output()).not.toContain("Updated to");
  });

  it("fails when npm global root cannot be read", async () => {
    fixture.exec.mockImplementation((command: string) => {
      if (command.startsWith("npm view ")) return fixture.remote;
      if (command === "npm root -g") throw new Error("root unavailable");
      return "";
    });
    await expect(runUpdate()).rejects.toBe(fixture.exit);
    expect(output()).not.toContain("Updated to");
  });

  it("retains shell-based npm invocation for Windows npm.cmd", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await runUpdate();
    expect(installs()).toEqual(["npm install -g @actalk/inkos@2.0.0"]);
    expect(fixture.exec).toHaveBeenNthCalledWith(2, "npm install -g @actalk/inkos@2.0.0", { stdio: "inherit" });
  });
});

describe("SemVer precedence", () => {
  it.each([
    ["2.0.0-dev.9", "2.0.0-dev.10"],
    ["2.0.0-1", "2.0.0-alpha"],
    ["2.0.0-alpha", "2.0.0-alpha.1"],
    ["2.0.0-alpha.1", "2.0.0-alpha.beta"],
    ["2.0.0-alpha.beta", "2.0.0-beta"],
    ["2.0.0-beta", "2.0.0-rc.1"],
    ["2.0.0-rc.1", "2.0.0"],
    ["2.0.0-A", "2.0.0-a"],
    ["2.0.0-alpha-1", "2.0.0-alpha-2"],
    ["2.0.0-9007199254740992", "2.0.0-9007199254740993"],
    ["9007199254740992.0.0", "9007199254740993.0.0"],
    ["0.9007199254740992.0", "0.9007199254740993.0"],
    ["0.0.9007199254740992", "0.0.9007199254740993"],
    ["9.99.99", "10.0.0"],
    ["2.0.0", "2.0.1-dev.1"],
  ])("orders %s < %s in both directions", async (older, newer) => {
    const { compareSemVer } = await import("../commands/update.js");
    expect(compareSemVer(older, newer)).toBe(-1);
    expect(compareSemVer(newer, older)).toBe(1);
  });

  it.each(["0.0.0", "2.0.0", "2.0.0-dev.1", "2.0.0-01a", "2.0.0--"])("ignores build metadata for %s", async (version) => {
    const { compareSemVer } = await import("../commands/update.js");
    expect(compareSemVer(`${version}+001.a-b`, `${version}+other`)).toBe(0);
    expect(compareSemVer(version, version)).toBe(0);
  });

  it.each(["1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha.00", "1.2.3-",
    "1.2.3+", "1.2.3-a..b", "1.2.3+a..b", "1.2.3+a+b", "v1.2.3", "1.2.3_foo", "1.2.3-中文", "1.2.3\n",
    " 1.2.3", "1.2.3;echo", "1.2.3&echo", "1.2.3|echo", "1.2.3`echo`", "1.2.3$(echo)", "1.2.3 --force", "1.2.3\0"])(
    "rejects invalid SemVer %j", async (invalid) => {
      const { compareSemVer } = await import("../commands/update.js");
      expect(() => compareSemVer(invalid, "1.2.3")).toThrow("Invalid semantic version");
      expect(() => compareSemVer("1.2.3", invalid)).toThrow("Invalid semantic version");
    },
  );
});

describe.skipIf(process.platform === "win32")("update in a controlled process", () => {
  it.each(["success", "mismatch", "missing", "install-error", "invalid-registry"])("has a real exit code for %s", async (scenario) => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { tmpdir } = await import("node:os");
    const { createRequire } = await vi.importActual<typeof import("node:module")>("node:module");
    const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const ts = await import("typescript");
    const root = fs.mkdtempSync(join(tmpdir(), "inkos-update-fixture-"));
    try {
      const commandsPath = join(root, "src", "commands");
      const bin = join(root, "bin");
      const globalRoot = join(root, "global with spaces");
      const installedDir = join(globalRoot, "@actalk", "inkos");
      fs.mkdirSync(commandsPath, { recursive: true });
      fs.mkdirSync(bin);
      fs.mkdirSync(installedDir, { recursive: true });
      fs.mkdirSync(join(root, "node_modules"));
      fs.symlinkSync(dirname(createRequire(import.meta.url).resolve("commander")), join(root, "node_modules", "commander"), "dir");
      fs.writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "2.0.0-dev.1" }));
      const source = fs.readFileSync(new URL("../commands/update.ts", import.meta.url), "utf-8");
      fs.writeFileSync(join(commandsPath, "update.js"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
      fs.writeFileSync(join(root, "src", "utils.js"), "export const log = console.log; export const logError = console.error;");
      fs.writeFileSync(join(root, "run.js"), 'import { updateCommand } from "./src/commands/update.js"; await updateCommand.parseAsync(["node", "inkos"]);');
      fs.writeFileSync(join(bin, "npm"), `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.INKOS_FIXTURE_EVENTS, JSON.stringify(args) + '\\n');
const scenario = process.env.INKOS_FIXTURE_SCENARIO;
if (args[0] === 'view') console.log(scenario === 'invalid-registry' ? '2.0.0; echo injected' : '2.0.0');
else if (args[0] === 'install') {
  if (scenario === 'install-error') process.exit(7);
  writeFileSync(process.env.INKOS_FIXTURE_DRIFT, '2.1.0');
  if (scenario !== 'missing') writeFileSync(join(process.env.INKOS_FIXTURE_GLOBAL, '@actalk', 'inkos', 'package.json'), JSON.stringify({name:'@actalk/inkos',version:scenario === 'mismatch' ? '2.1.0' : '2.0.0'}));
} else if (args.join(' ') === 'root -g') console.log(process.env.INKOS_FIXTURE_GLOBAL);
else process.exit(9);
`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [join(root, "run.js")], {
        encoding: "utf-8", timeout: 15_000,
        env: { ...process.env, PATH: bin, INKOS_FIXTURE_SCENARIO: scenario, INKOS_FIXTURE_GLOBAL: globalRoot,
          INKOS_FIXTURE_EVENTS: join(root, "events"), INKOS_FIXTURE_DRIFT: join(root, "latest-after-install") },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(scenario === "success" ? 0 : 1);
      const events = fs.readFileSync(join(root, "events"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      const expected = [["view", "@actalk/inkos@latest", "version"]];
      if (scenario !== "invalid-registry") expected.push(["install", "-g", "@actalk/inkos@2.0.0"]);
      if (!["invalid-registry", "install-error"].includes(scenario)) expected.push(["root", "-g"]);
      expect(events).toEqual(expected);
      if (scenario === "success") {
        expect(result.stdout).toContain("Updated to 2.0.0.");
        expect(fs.readFileSync(join(root, "latest-after-install"), "utf-8")).toBe("2.1.0");
      } else {
        expect(result.stdout).not.toContain("Updated to");
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
