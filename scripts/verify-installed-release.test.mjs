import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./verify-installed-release.mjs", import.meta.url));
const version = "2.3.4-test.1";
const CLI = "@actalk/inkos";
const CORE = "@actalk/inkos-core";
const STUDIO = "@actalk/inkos-studio";

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function manifest(dir, value) {
  write(join(dir, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function rewriteManifest(dir, change) {
  const path = join(dir, "package.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  change(value);
  manifest(dir, value);
}

function makeCore(parent, installedVersion = version) {
  const dir = join(parent, "node_modules", CORE);
  manifest(dir, {
    name: CORE, version: installedVersion, type: "module", main: "dist/index.js",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./llm/api-format": { types: "./dist/llm/api-format.d.ts", import: "./dist/llm/api-format.js" },
    },
  });
  write(join(dir, "dist/index.js"), `export const version = ${JSON.stringify(installedVersion)};\n`);
  write(join(dir, "dist/index.d.ts"), "export declare const version: string;\n");
  write(join(dir, "dist/llm/api-format.js"), "export const format = 'fixture';\n");
  write(join(dir, "dist/llm/api-format.d.ts"), "export declare const format: string;\n");
  return dir;
}

function makeStudio(parent) {
  const dir = join(parent, "node_modules", STUDIO);
  manifest(dir, { name: STUDIO, version, type: "module", main: "dist/api/index.js" });
  // Resolution must not execute this side effect.
  write(join(dir, "dist/api/index.js"), "throw new Error('Studio must not be imported by the verifier');\n");
  write(join(dir, "dist/index.html"), "<!doctype html><title>Fixture Studio</title>\n");
  write(join(dir, "dist/assets/app.js"), "console.log('fixture');\n");
  return dir;
}

function makeCli(parent, probe) {
  const dir = join(parent, "node_modules", CLI);
  manifest(dir, { name: CLI, version, type: "module", bin: { inkos: "dist/index.js" } });
  write(join(dir, "dist/index.js"), `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
assert.deepEqual(Object.keys(process.env).sort(), ['HOME', 'PATH']);
assert.equal(process.cwd(), process.env.HOME);
assert.deepEqual(process.argv.slice(2), ['--version']);
writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv }));
console.log('  ${version}  ');
`);
  return dir;
}

function fixture(t, layout = "flat") {
  const dir = mkdtempSync(join(tmpdir(), "inkos-installed-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "install");
  manifest(root, { name: "fixture-install", version: "0.0.0", private: true, type: "module" });
  const parentHome = join(dir, "parent-home");
  mkdirSync(parentHome);
  const probe = join(dir, "cli-invocation.json");
  const cli = makeCli(root, probe);
  const core = makeCore(layout === "flat" ? root : cli);
  const studio = makeStudio(layout === "flat" ? root : cli);
  const studioCore = layout === "flat" ? core : makeCore(studio);
  return { dir, root, parentHome, probe, cli, core, studio, studioCore, output: join(dir, "report.json") };
}

function run(f) {
  const result = spawnSync(process.execPath, [script, "--root", f.root, "--version", version, "--output", f.output], {
    // Deliberately pass mock configuration; the verifier must strip it from children.
    env: { PATH: process.env.PATH ?? "", HOME: f.parentHome, INKOS_API_KEY: "mock-only", NODE_OPTIONS: "--no-warnings" },
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, report: existsSync(f.output) ? JSON.parse(readFileSync(f.output, "utf8")) : null };
}

function assertReport(result, status) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.report.exit, status);
  assert.equal(result.report.passed, status === 0);
  assert.equal(result.report.expectedVersion, version);
  for (const item of result.report.checks) {
    assert.ok(["pass", "fail"].includes(item.status));
    for (const field of ["path", "version", "exit"]) assert.ok(Object.hasOwn(item, field), `${item.id}: ${field}`);
  }
  assert.equal(result.report.checks.some((item) => item.status === "fail"), status !== 0);
}

function item(result, id) {
  const found = result.report.checks.find((entry) => entry.id === id);
  assert.ok(found, `Missing check ${id}`);
  return found;
}

test("flat install follows ESM-only Core exports and isolates CLI environment", (t) => {
  const f = fixture(t);
  const require = createRequire(join(f.cli, "dist/index.js"));
  assert.throws(() => require.resolve(`${CORE}/package.json`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  assert.throws(() => require.resolve(CORE), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  const result = run(f);
  assertReport(result, 0);
  assert.equal(item(result, "cli.package").path, join(f.cli, "package.json"));
  assert.equal(item(result, "cli.core.package").path, join(f.core, "package.json"));
  assert.equal(item(result, "cli.studio.package").path, join(f.studio, "package.json"));
  assert.equal(item(result, "studio.core.package").path, join(f.core, "package.json"));
  assert.equal(item(result, "cli.version").exit, 0);
  const probe = JSON.parse(readFileSync(f.probe, "utf8"));
  assert.deepEqual(Object.keys(probe.env).sort(), ["HOME", "PATH"]);
  assert.notEqual(probe.env.HOME, f.parentHome);
  assert.equal(probe.cwd, probe.env.HOME);
  assert.equal(probe.argv[1], join(f.cli, "dist/index.js"));
  assert.equal(existsSync(probe.env.HOME), false, "Temporary HOME must be removed");
});

test("nested install resolves CLI and Studio dependencies instead of hoisted decoys", (t) => {
  const f = fixture(t, "nested");
  makeCore(f.root, "0.0.1");
  const decoy = makeStudio(f.root);
  rewriteManifest(decoy, (pkg) => { pkg.version = "0.0.1"; });
  const result = run(f);
  assertReport(result, 0);
  assert.equal(item(result, "cli.core.package").path, join(f.core, "package.json"));
  assert.equal(item(result, "cli.studio.package").path, join(f.studio, "package.json"));
  assert.equal(item(result, "studio.core.package").path, join(f.studioCore, "package.json"));
});

test("resolves Studio Core from its actual main entry", (t) => {
  const f = fixture(t, "nested");
  rewriteManifest(f.studio, (pkg) => { pkg.main = "runtime/index.js"; });
  write(join(f.studio, "runtime/index.js"), "throw new Error('Must not execute');\n");
  const runtimeCore = makeCore(join(f.studio, "runtime"), "0.0.1");
  const result = run(f);
  assertReport(result, 1);
  assert.equal(item(result, "studio.api").status, "pass");
  assert.equal(item(result, "studio.core.package").status, "fail");
  assert.equal(item(result, "studio.core.package").path, join(runtimeCore, "package.json"));
  assert.equal(item(result, "studio.core.package").version, "0.0.1");
});

for (const [key, id] of [
  ["cli", "cli.package"], ["core", "cli.core.package"],
  ["studio", "cli.studio.package"], ["studioCore", "studio.core.package"],
]) {
  test(`rejects an old ${key} package in the actual nested dependency graph`, (t) => {
    const f = fixture(t, "nested");
    makeCore(f.root); // A matching top-level version must not hide a stale nested copy.
    rewriteManifest(f[key], (pkg) => { pkg.version = "0.0.1"; });
    const result = run(f);
    assertReport(result, 1);
    assert.equal(item(result, id).status, "fail");
    assert.equal(item(result, id).version, "0.0.1");
    assert.equal(item(result, id).path, join(f[key], "package.json"));
  });
}

for (const [key, target, id] of [
  ["cli", "dist/index.js", "cli.bin"],
  ["core", "dist/index.js", "cli.core.package"],
  ["core", "dist/index.d.ts", "cli.core.export:./dist/index.d.ts"],
  ["core", "dist/llm/api-format.js", "cli.core.export:./dist/llm/api-format.js"],
  ["studio", "dist/api/index.js", "cli.studio.package"],
  ["studio", "dist/index.html", "studio.html"],
  ["studio", "dist/assets", "studio.assets"],
]) {
  test(`rejects missing ${key}/${target}`, (t) => {
    const f = fixture(t);
    rmSync(join(f[key], target), { recursive: true });
    const result = run(f);
    assertReport(result, 1);
    assert.equal(item(result, id).status, "fail");
    if (key === "cli") assert.equal(existsSync(f.probe), false);
  });
}

test("rejects an undeclared CLI bin", (t) => {
  const f = fixture(t);
  rewriteManifest(f.cli, (pkg) => { delete pkg.bin; });
  const result = run(f);
  assertReport(result, 1);
  assert.equal(item(result, "cli.bin").status, "fail");
  assert.equal(item(result, "cli.version").exit, null);
  assert.equal(existsSync(f.probe), false);
});

test("rejects absent Core exports even when main resolves", (t) => {
  const f = fixture(t);
  rewriteManifest(f.core, (pkg) => { delete pkg.exports; });
  const result = run(f);
  assertReport(result, 1);
  assert.equal(item(result, "cli.core.exports").status, "fail");
  assert.equal(item(result, "studio.core.exports").status, "fail");
});

test("rejects a CLI that prints the wrong version", (t) => {
  const f = fixture(t);
  write(join(f.cli, "dist/index.js"), "console.log('0.0.1');\n");
  const result = run(f);
  assertReport(result, 1);
  assert.equal(item(result, "cli.version").status, "fail");
  assert.equal(item(result, "cli.version").stdout, "0.0.1\n");
  assert.equal(item(result, "cli.version").exit, 0);
});

test("rejects a nonzero CLI exit even with matching stdout", (t) => {
  const f = fixture(t);
  write(join(f.cli, "dist/index.js"), `console.log(${JSON.stringify(version)}); process.exitCode = 7;\n`);
  const result = run(f);
  assertReport(result, 1);
  assert.equal(item(result, "cli.version").status, "fail");
  assert.equal(item(result, "cli.version").exit, 7);
});

test("rejects a CLI bin path outside its package without executing it", (t) => {
  const f = fixture(t);
  const escape = join(f.root, "escape.mjs");
  write(escape, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(f.probe)}, 'executed');\n`);
  rewriteManifest(f.cli, (pkg) => { pkg.bin.inkos = "../../../escape.mjs"; });
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "cli.bin").error, /escapes package/);
  assert.equal(existsSync(f.probe), false);
});

test("rejects a symlinked CLI bin outside its package without executing it", (t) => {
  const f = fixture(t);
  const bin = join(f.cli, "dist/index.js");
  const escape = join(f.root, "escape.mjs");
  write(escape, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(f.probe)}, 'executed');\n`);
  rmSync(bin);
  symlinkSync(escape, bin);
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "cli.bin").error, /escapes package/);
  assert.equal(existsSync(f.probe), false);
});

test("rejects a Core entry that resolves outside its owning package", (t) => {
  const f = fixture(t);
  const entry = join(f.core, "dist/index.js");
  const escape = join(f.root, "escape.mjs");
  write(escape, "throw new Error('Must not execute');\n");
  rmSync(entry);
  symlinkSync(escape, entry);
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "cli.core.package").error, /Entry belongs to fixture-install/);
});

test("rejects an escaped Core declared subpath export", (t) => {
  const f = fixture(t);
  const target = join(f.core, "dist/llm/api-format.js");
  const escape = join(f.root, "escape.mjs");
  write(escape, "export const format = 'escape';\n");
  rmSync(target);
  symlinkSync(escape, target);
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "cli.core.export:./dist/llm/api-format.js").error, /escapes package/);
});

test("rejects a Studio frontend path escaping the package", (t) => {
  const f = fixture(t);
  const target = join(f.studio, "dist/index.html");
  const escape = join(f.root, "escape.html");
  write(escape, "<!doctype html><title>Escape</title>\n");
  rmSync(target);
  symlinkSync(escape, target);
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "studio.html").error, /escapes package/);
});

test("rejects a mismatched package name at the resolved entry", (t) => {
  const f = fixture(t);
  rewriteManifest(f.core, (pkg) => { pkg.name = "unrelated-core"; });
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "cli.core.package").error, /Entry belongs to unrelated-core/);
});

test("does not accept packages inherited from above the fresh installation root", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "node_modules"), { recursive: true });
  makeCli(f.dir, f.probe);
  const result = run(f);
  assertReport(result, 1);
  assert.match(item(result, "cli.package").error, /escapes installation root/);
  assert.equal(existsSync(f.probe), false);
});

test("refuses an existing report before invoking CLI and preserves its contents", (t) => {
  const f = fixture(t);
  const original = '{"preserve":"existing report"}\n';
  write(f.output, original);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite existing output/);
  assert.equal(readFileSync(f.output, "utf8"), original);
  assert.equal(existsSync(f.probe), false);
});

test("refuses a symlinked existing output without changing its target", (t) => {
  const f = fixture(t);
  const target = join(f.dir, "existing.json");
  write(target, '{"preserve":true}\n');
  symlinkSync(target, f.output);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite existing output/);
  assert.equal(readFileSync(target, "utf8"), '{"preserve":true}\n');
  assert.equal(existsSync(f.probe), false);
});

test("records a missing installation root as a failed report", (t) => {
  const f = fixture(t);
  f.root = resolve(f.dir, "missing");
  const result = run(f);
  assertReport(result, 1);
  assert.equal(item(result, "root").status, "fail");
  assert.equal(existsSync(f.probe), false);
});

test("import has no CLI side effects and exposes the shared nested-package resolver", (t) => {
  const f = fixture(t, "nested");
  const decoy = makeStudio(f.root);
  write(join(decoy, "dist/api/index.js"), "process.exitCode = 0;\n");
  write(join(f.studio, "dist/api/index.js"), "process.exitCode = 23;\n");
  const importer = join(f.dir, "importer.mjs");
  write(importer, `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let argvReads = 0;
process.argv = new Proxy(${JSON.stringify([process.execPath, importer, "--root", f.root, "--version", version, "--output", f.output])}, {
  get(target, key) {
    if (key === 'slice') { argvReads += 1; throw new Error('Import parsed CLI arguments'); }
    return Reflect.get(target, key);
  },
});
let childCalls = 0;
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = (...args) => { childCalls += 1; return originalSpawn(...args); };
syncBuiltinESMExports();
const module = await import(${JSON.stringify(new URL("./verify-installed-release.mjs", import.meta.url).href)});
assert.deepEqual(Object.keys(module), ['resolveInstalledPackage']);
assert.equal(typeof module.resolveInstalledPackage, 'function');
assert.equal(argvReads, 0);
assert.equal(childCalls, 0);
assert.equal(process.exitCode, undefined);
assert.equal(existsSync(${JSON.stringify(f.output)}), false);
assert.equal(existsSync(${JSON.stringify(f.probe)}), false);
childProcess.spawnSync = originalSpawn;
syncBuiltinESMExports();
const item = {};
const pkg = module.resolveInstalledPackage({
  root: ${JSON.stringify(f.root)}, specifier: ${JSON.stringify(STUDIO)},
  parent: ${JSON.stringify(join(f.cli, "dist/index.js"))}, name: ${JSON.stringify(STUDIO)},
  childOptions: { env: { PATH: process.env.PATH, HOME: process.env.HOME }, cwd: process.env.HOME, timeout: 10000 },
  item,
});
assert.deepEqual(Object.keys(pkg).sort(), ['dir', 'entry', 'manifest', 'manifestPath']);
assert.equal(pkg.dir, ${JSON.stringify(f.studio)});
assert.equal(pkg.entry, ${JSON.stringify(join(f.studio, "dist/api/index.js"))});
assert.equal(pkg.manifestPath, ${JSON.stringify(join(f.studio, "package.json"))});
assert.equal(pkg.manifest.name, ${JSON.stringify(STUDIO)});
assert.equal(pkg.manifest.version, ${JSON.stringify(version)});
assert.equal(item.path, pkg.manifestPath);
assert.equal(item.entry, pkg.entry);
assert.equal(item.version, pkg.manifest.version);
assert.equal(item.exit, 0);
assert.equal(process.exitCode, undefined);
assert.equal(existsSync(${JSON.stringify(f.output)}), false);
assert.equal(existsSync(${JSON.stringify(f.probe)}), false);
console.log('import-safe');
`);
  const result = spawnSync(process.execPath, [importer], {
    env: { PATH: process.env.PATH ?? "", HOME: f.parentHome }, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "import-safe\n");
  assert.equal(result.stderr, "");
  assert.equal(existsSync(f.output), false);
  assert.equal(existsSync(f.probe), false);
});
