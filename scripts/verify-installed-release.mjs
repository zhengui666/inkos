// Verify a fresh installation without importing Core/Studio or starting services.
// Usage: node scripts/verify-installed-release.mjs --root <install-root> --version <expected> --output <new-json>
import { spawnSync } from "node:child_process";
import {
  closeSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI = "@actalk/inkos";
const CORE = "@actalk/inkos-core";
const STUDIO = "@actalk/inkos-studio";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--root", "--version", "--output"].includes(key)
      || key in args || !value || value.startsWith("--")) {
      throw new Error("Usage: node scripts/verify-installed-release.mjs --root <install-root> --version <expected> --output <new-json>");
    }
    args[key] = value;
  }
  if (Object.keys(args).length !== 3) {
    throw new Error("--root, --version and --output are required");
  }
  return { root: resolve(args["--root"]), version: args["--version"], output: resolve(args["--output"]) };
}

function isInside(parent, path) {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Shared by installed-release verifiers. Resolve only; do not evaluate packages.
export function resolveInstalledPackage({ root, specifier, parent, name, childOptions, item = {} }) {
  root = realpathSync(root);
  if (!parent) throw new Error("Importer package is unavailable");
  // The second import.meta.resolve argument needs this flag on Node 22.
  const result = spawnSync(process.execPath, [
    "--experimental-import-meta-resolve", "--input-type=module", "--eval",
    "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
    specifier, pathToFileURL(parent).href,
  ], { encoding: "utf8", ...childOptions });
  item.exit = result.status;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Resolver exited ${result.status}`);
  const entry = fileURLToPath(result.stdout.trim());
  item.path = entry;
  const actualEntry = realpathSync(entry);
  if (!isInside(root, actualEntry)) throw new Error(`Entry escapes installation root: ${actualEntry}`);
  if (!statSync(actualEntry).isFile()) throw new Error(`Entry is not a file: ${actualEntry}`);
  let dir = dirname(actualEntry);
  while (isInside(root, dir)) {
    const manifestPath = join(dir, "package.json");
    let raw;
    try {
      const actualManifest = realpathSync(manifestPath);
      if (!isInside(dir, actualManifest)) throw new Error(`Manifest escapes package: ${actualManifest}`);
      raw = readFileSync(actualManifest, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      const manifest = JSON.parse(raw);
      item.path = manifestPath;
      item.version = manifest.version ?? null;
      item.entry = actualEntry;
      if (manifest.name !== name) {
        throw new Error(`Entry belongs to ${manifest.name ?? "unnamed package"}; expected ${name}`);
      }
      if (!isInside(dir, actualEntry)) {
        throw new Error(`Entry or manifest escapes package: ${actualEntry}`);
      }
      return { dir, manifestPath, manifest, entry: actualEntry };
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error(`No owning package.json found for ${name}: ${actualEntry}`);
}

function verify(options) {
  const checks = [];
  function check(id, details, run) {
    const item = { id, status: "fail", path: null, version: null, exit: null, ...details };
    checks.push(item);
    try {
      const value = run(item);
      item.status = "pass";
      return value;
    } catch (error) {
      item.error = error.message;
      return undefined;
    }
  }

  const root = check("root", { path: options.root }, (item) => {
    const path = realpathSync(options.root);
    item.path = path;
    if (!statSync(path).isDirectory()) throw new Error("Installation root must be a directory");
    return path;
  });
  if (!root) return { root: options.root, expectedVersion: options.version, passed: false, exit: 1, checks };

  const home = mkdtempSync(join(tmpdir(), "inkos-release-home-"));
  const childOptions = {
    env: { PATH: process.env.PATH ?? "", HOME: home },
    cwd: home, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  };

  function packageCheck(id, specifier, parent, name) {
    let pkg;
    check(id, { path: parent ?? null }, (item) => {
      pkg = resolveInstalledPackage({ root, specifier, parent, name, childOptions, item });
      if (pkg.manifest.version !== options.version) {
        throw new Error(`Expected ${name}@${options.version}; found ${pkg.manifest.version}`);
      }
    });
    return pkg;
  }

  function fileCheck(id, pkg, target, kind = "file") {
    return check(id, {
      path: pkg && typeof target === "string" ? resolve(pkg.dir, target) : null,
      version: pkg?.manifest.version ?? null,
    }, (item) => {
      if (!pkg) throw new Error("Owning package is unavailable");
      if (typeof target !== "string" || !target) throw new Error("Missing entry declaration");
      const path = resolve(pkg.dir, target);
      if (!isInside(pkg.dir, path)) throw new Error(`Entry escapes package: ${path}`);
      const actual = realpathSync(path);
      if (!isInside(pkg.dir, actual)) throw new Error(`Entry escapes package: ${actual}`);
      item.path = actual;
      const stat = statSync(actual);
      if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error(`Expected a ${kind}: ${actual}`);
      }
      return actual;
    });
  }

  function coreFiles(id, pkg) {
    const targets = check(`${id}.exports`, {
      path: pkg?.manifestPath ?? null, version: pkg?.manifest.version ?? null,
    }, (item) => {
      if (!pkg) throw new Error("Core package is unavailable");
      const paths = new Set();
      function collect(value) {
        if (typeof value === "string") {
          if (!value.startsWith("./") || value.includes("*")) {
            throw new Error(`Expected an explicit relative export target: ${value}`);
          }
          paths.add(value);
        } else if (value && typeof value === "object") {
          for (const child of Object.values(value)) collect(child);
        } else if (value !== null) {
          throw new Error("Missing or invalid Core exports");
        }
      }
      collect(pkg.manifest.exports);
      if (paths.size === 0) throw new Error("Core exports declare no files");
      item.targets = [...paths];
      return item.targets;
    });
    for (const target of targets ?? []) fileCheck(`${id}.export:${target}`, pkg, target);
  }

  try {
    // CLI has a bin but no main; Core's exports hide its package.json.
    const cli = packageCheck("cli.package", `${CLI}/package.json`, join(root, "release-probe.mjs"), CLI);
    const bin = fileCheck("cli.bin", cli,
      typeof cli?.manifest.bin === "string" ? cli.manifest.bin : cli?.manifest.bin?.inkos);
    const core = packageCheck("cli.core.package", CORE, bin, CORE);
    const studio = packageCheck("cli.studio.package", STUDIO, bin, STUDIO);
    coreFiles("cli.core", core);
    fileCheck("studio.api", studio, "dist/api/index.js");
    fileCheck("studio.html", studio, "dist/index.html");
    fileCheck("studio.assets", studio, "dist/assets", "directory");
    const studioCore = packageCheck("studio.core.package", CORE, studio?.entry, CORE);
    coreFiles("studio.core", studioCore);

    check("cli.version", { path: bin ?? null, version: cli?.manifest.version ?? null }, (item) => {
      if (!bin) throw new Error("CLI bin is unavailable; refusing to execute");
      item.command = [process.execPath, bin, "--version"];
      const result = spawnSync(process.execPath, [bin, "--version"], { ...childOptions, cwd: home });
      item.exit = result.status;
      item.signal = result.signal;
      item.stdout = result.stdout ?? "";
      item.stderr = result.stderr ?? "";
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`CLI exited ${result.status}`);
      if (result.stdout.trim() !== options.version) {
        throw new Error(`Expected CLI stdout ${options.version}; found ${JSON.stringify(result.stdout.trim())}`);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const passed = checks.every((item) => item.status === "pass");
  return { root, expectedVersion: options.version, passed, exit: passed ? 0 : 1, checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    let fd;
    try {
      fd = openSync(options.output, "wx");
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`Refusing to overwrite existing output: ${options.output}`);
      throw error;
    }
    try {
      const report = verify(options);
      writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.exit;
      console.log(`${report.passed ? "PASS" : "FAIL"}: ${options.output}`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
