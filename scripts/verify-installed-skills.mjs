// Compare a packaged Core skill tree with this checkout, then exercise its actual runtime.
// Usage: node scripts/verify-installed-skills.mjs --core-root <package-root> --output <new-json>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUILTIN_SKILL_IDS = Object.freeze([
  "inkos-continuation-writing", "inkos-fanfic-writing", "inkos-imitation-writing",
  "inkos-interactive-film", "inkos-long-market-research", "inkos-long-story-analysis",
  "inkos-long-writing", "inkos-play-illustration", "inkos-play-world", "inkos-script-writing",
  "inkos-short-market-research", "inkos-short-story-analysis", "inkos-short-writing",
  "inkos-spinoff-writing", "inkos-story-cover", "inkos-story-deslop", "inkos-story-import",
  "inkos-story-review", "inkos-storyboard", "inkos-translation",
]);

const sourceSkillsRoot = fileURLToPath(new URL("../packages/core/skills/", import.meta.url));

function inside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function directoryRoot(path) {
  const root = resolve(path);
  assert(!lstatSync(root).isSymbolicLink(), `Symbolic link is not allowed: ${root}`);
  assert(lstatSync(root).isDirectory(), `Not a directory: ${root}`);
  return realpathSync(root);
}

function containedPath(root, path, kind = "file") {
  const full = resolve(root, path);
  assert(inside(root, full), `Path escapes package root: ${path}`);
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    assert(!lstatSync(current).isSymbolicLink(), `Symbolic link is not allowed: ${current}`);
  }
  assert(inside(root, realpathSync(full)), `Path escapes package root: ${path}`);
  const info = lstatSync(full);
  assert(kind === "directory" ? info.isDirectory() : info.isFile(), `Not a ${kind}: ${path}`);
  return full;
}

function resolvePublicEntry(root, packageName) {
  const parent = pathToFileURL(join(root, "package.json")).href;
  const result = spawnSync(process.execPath, [
    "--experimental-import-meta-resolve", "--input-type=module", "--eval",
    "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
    packageName, parent,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root, ...(process.platform === "win32" ? { USERPROFILE: root } : {}) },
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Public entry resolver exited ${result.status}`);
  const resolved = new URL(result.stdout.trim());
  assert.equal(resolved.protocol, "file:", "Core public entry must resolve to a file URL");
  const target = fileURLToPath(resolved);
  assert(inside(root, target), `Resolved Core public entry escapes package root: ${target}`);
  return containedPath(root, relative(root, target));
}

function textFile(path, limit) {
  assert(lstatSync(path).size <= limit, `Text file is too large: ${path}`);
  const bytes = readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assert(!text.includes("\0") && text.trim(), `Invalid or empty text: ${path}`);
  return { bytes, text };
}

function inventory(root) {
  const files = [];
  function walk(path) {
    for (const name of readdirSync(containedPath(root, path, "directory")).sort()) {
      const child = path ? `${path}/${name}` : name;
      const full = resolve(root, child);
      assert(!lstatSync(full).isSymbolicLink(), `Symbolic link is not allowed: ${full}`);
      if (lstatSync(full).isDirectory()) { walk(child); continue; }
      containedPath(root, child);
      const { bytes } = textFile(full, child.endsWith("/SKILL.md") ? 2 * 1024 * 1024 : 512 * 1024);
      files.push({ path: child, bytes: bytes.length, content: bytes });
    }
  }
  walk("");
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// Extract literal code/Markdown links independently of the packaged loader.
function linkedPaths(text) {
  const paths = new Set();
  for (const match of text.matchAll(/`((?:references|examples)\/[^`\n]+)`|\[[^\]\n]*\]\(((?:references|examples)\/[^)\n]+)\)/g)) {
    const path = match[1] ?? match[2];
    if (/\.(?:md|txt)$/i.test(path)) paths.add(path);
  }
  return [...paths].sort();
}

const runtimeProbe = String.raw`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, entry, toolEntry] = process.argv.slice(1);
const core = await import(pathToFileURL(entry).href);
const { loadLinkedSkillResources } = await import(pathToFileURL(toolEntry).href);
const loaded = await core.loadBuiltinAgentSkills(); // Deliberately use its default packaged root.
assert.deepEqual(loaded.diagnostics, [], "Builtin catalog has diagnostics");
const skills = [];
for (const skill of loaded.skills) {
  const baseDir = join(root, "skills", skill.id);
  assert.equal(skill.baseDir, baseDir, "Builtin loader resolved the wrong package directory");
  const parsed = core.parseAgentSkillDocument(readFileSync(join(baseDir, "SKILL.md"), "utf8"),
    { skillPath: join(baseDir, "SKILL.md"), source: "builtin" });
  assert.deepEqual(skill, parsed, "Catalog does not match the packaged manifest");
  skills.push({ id: skill.id, resources: await loadLinkedSkillResources(skill) });
}
const profiles = core.builtInWorkProfiles().map(profile => ({ id: profile.id, requiredSkillIds: [...profile.requiredSkillIds].sort() }));
console.log(JSON.stringify({ skills, profiles }));
`;

/** No builds, installations, agents or providers. sourceSkillsRoot must be a trusted, separate source tree. */
export function verifyInstalledSkills(options) {
  const report = { coreRoot: resolve(options.coreRoot), passed: false, exit: 1, skills: [], profiles: [], files: [] };
  let home;
  try {
    const root = directoryRoot(options.coreRoot);
    report.coreRoot = root;
    const expectedRoot = directoryRoot(options.sourceSkillsRoot ?? sourceSkillsRoot);
    const skillsRoot = containedPath(root, "skills", "directory");
    assert(!inside(skillsRoot, expectedRoot) && !inside(expectedRoot, skillsRoot), "Trusted source and packaged skills must be separate trees");
    const manifest = JSON.parse(textFile(containedPath(root, "package.json"), 2 * 1024 * 1024).text);
    assert.equal(manifest.name, "@actalk/inkos-core", "Expected the Core package");
    const entry = resolvePublicEntry(root, manifest.name);
    const toolEntry = containedPath(root, "dist/agent/skill-tool.js");
    // Check the complete tree before importing anything; no resource symlink is followed.
    const expectedFiles = inventory(expectedRoot);
    const installedFiles = inventory(skillsRoot);
    report.files = installedFiles.map(({ path, bytes }) => ({ path, bytes }));
    assert.deepEqual(report.files.map(file => file.path), expectedFiles.map(file => file.path), "Packaged skill/reference inventory differs from trusted source");
    for (let i = 0; i < expectedFiles.length; i++) {
      assert(installedFiles[i].content.equals(expectedFiles[i].content), `Packaged resource bytes differ: ${expectedFiles[i].path}`);
    }
    const ids = expectedFiles.filter(file => file.path.endsWith("/SKILL.md")).map(file => file.path.slice(0, -"/SKILL.md".length)).sort();
    assert.deepEqual(ids, BUILTIN_SKILL_IDS, "Trusted source does not contain the exact builtin catalog");
    const expectedSkills = ids.map(id => {
      const body = textFile(containedPath(expectedRoot, `${id}/SKILL.md`), 2 * 1024 * 1024).text;
      const references = linkedPaths(body).map(path => {
        assert(!path.includes("\\") && !path.split("/").some(part => !part || part === "." || part === ".."), `Invalid literal skill reference: ${id}/${path}`);
        const full = containedPath(skillsRoot, `${id}/${path}`);
        const { bytes, text } = textFile(full, 512 * 1024);
        return { path, bytes: bytes.length, text };
      });
      return { id, references };
    });
    home = mkdtempSync(join(tmpdir(), "inkos-skill-pack-home-"));
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", runtimeProbe, root, entry, toolEntry], {
      cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home,
        ...(process.platform === "win32" ? { USERPROFILE: home } : {}) },
      encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr?.trim() || `Packaged Core probe exited ${child.status} (${child.signal})`);
    const runtime = JSON.parse(child.stdout);
    assert.deepEqual(runtime.skills.map(skill => skill.id).sort(), ids, "Packaged runtime returned an incomplete or duplicate catalog");
    for (const expected of expectedSkills) {
      const resources = runtime.skills.find(skill => skill.id === expected.id).resources;
      assert.deepEqual(resources.map(resource => resource.path).sort(), expected.references.map(file => file.path), `Linked reference inventory differs: ${expected.id}`);
      for (const file of expected.references) {
        const resource = resources.find(resource => resource.path === file.path);
        assert.equal(resource.body, file.text, `Linked reference bytes differ: ${expected.id}/${file.path}`);
        assert.equal(resource.charStart, 0, `Truncated reference start: ${expected.id}/${file.path}`);
        assert.equal(resource.charEnd, file.text.length, `Truncated reference end: ${expected.id}/${file.path}`);
      }
    }
    assert(Array.isArray(runtime.profiles) && runtime.profiles.length > 0, "Packaged Core has no builtin profiles");
    assert.equal(new Set(runtime.profiles.map(profile => profile.id)).size, runtime.profiles.length, "Duplicate builtin profiles");
    for (const profile of runtime.profiles) {
      assert(Array.isArray(profile.requiredSkillIds), `Invalid profile requirements: ${profile.id}`);
      for (const id of profile.requiredSkillIds) assert(ids.includes(id), `Profile ${profile.id} requires unavailable skill: ${id}`);
    }
    report.skills = expectedSkills.map(({ id, references }) => ({ id, references: references.map(({ text, ...file }) => file) }));
    report.profiles = runtime.profiles.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    report.passed = true;
    report.exit = 0;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
      assert(["--core-root", "--output"].includes(argv[i]) && !(argv[i] in args)
        && argv[i + 1] && !argv[i + 1].startsWith("--"), "Usage: --core-root <package-root> --output <new-json>");
      args[argv[i]] = argv[i + 1];
    }
    assert(args["--core-root"] && args["--output"], "--core-root and --output are required");
    const report = verifyInstalledSkills({ coreRoot: args["--core-root"] });
    writeFileSync(resolve(args["--output"]), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(`${report.passed ? "PASS" : "FAIL"}: ${args["--output"]}`);
    process.exitCode = report.exit;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
