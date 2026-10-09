import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BUILTIN_SKILL_IDS, verifyInstalledSkills } from "./verify-installed-skills.mjs";

const script = fileURLToPath(new URL("./verify-installed-skills.mjs", import.meta.url));
const firstSkill = BUILTIN_SKILL_IDS[0];
const reference = `${firstSkill}/references/receipt.md`;
const example = `${firstSkill}/examples/receipt.txt`;

// Synthetic package modules exercise the verifier, not the production runtime.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "inkos-skill-pack-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceSkillsRoot = join(root, "source-skills");
  const coreRoot = join(root, "consumer", "node_modules", "@actalk", "inkos-core");
  function write(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  for (const id of BUILTIN_SKILL_IDS) {
    const links = id === firstSkill ? "Read `references/receipt.md` and [example](examples/receipt.txt)." : "Synthetic fixture.";
    write(join(sourceSkillsRoot, id, "SKILL.md"), `---\nname: ${id}\ndescription: Synthetic fixture.\n---\n${links}\n`);
  }
  write(join(sourceSkillsRoot, reference), "# Synthetic receipt\r\n\r\nExact café receipt.\r\n");
  write(join(sourceSkillsRoot, example), "Synthetic example.\n");
  cpSync(sourceSkillsRoot, join(coreRoot, "skills"), { recursive: true });
  write(join(coreRoot, "package.json"), JSON.stringify({
    name: "@actalk/inkos-core", version: "0.0.0-fixture", type: "module", exports: { ".": { import: "./dist/index.js" } },
  }));
  write(join(coreRoot, "dist", "index.js"), `
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../skills", import.meta.url));
export function parseAgentSkillDocument(raw, { skillPath, source }) {
  const id = raw.match(/^name: (.+)$/m)[1];
  return { id, name: id, description: "Synthetic fixture.", source, baseDir: dirname(skillPath), body: raw.split("---\\n")[2].trim() };
}
export async function loadBuiltinAgentSkills() {
  return { diagnostics: [], skills: readdirSync(root).sort().map(id => {
    const skillPath = join(root, id, "SKILL.md");
    return parseAgentSkillDocument(readFileSync(skillPath, "utf8"), { skillPath, source: "builtin" });
  }) };
}
export function builtInWorkProfiles() { return [{ id: "fixture-profile", requiredSkillIds: [${JSON.stringify(firstSkill)}] }]; }
`);
  write(join(coreRoot, "dist", "agent", "skill-tool.js"), `
import { readFileSync } from "node:fs";
import { join } from "node:path";
export async function loadLinkedSkillResources(skill) {
  const paths = [...skill.body.matchAll(/(?:\x60|\\]\\()((?:references|examples)\\/[^\x60\\n)]+\\.(?:md|txt))(?:\x60|\\))/g)].map(match => match[1]);
  return paths.map(path => { const body = readFileSync(join(skill.baseDir, path), "utf8"); return { path, body, charStart: 0, charEnd: body.length }; });
}
`);
  return { root, coreRoot, sourceSkillsRoot, write, options: { coreRoot, sourceSkillsRoot } };
}

test("synthetic package returns a deterministic exact catalog and byte inventory", t => {
  const f = fixture(t);
  const report = verifyInstalledSkills(f.options);
  assert.equal(report.passed, true, report.error);
  assert.deepEqual(verifyInstalledSkills(f.options), report);
  assert.deepEqual(report.skills.map(skill => skill.id), BUILTIN_SKILL_IDS);
  assert.equal(report.files.length, 22);
  assert.deepEqual(report.skills[0].references.map(file => file.path), ["examples/receipt.txt", "references/receipt.md"]);
  assert.deepEqual(report.files.map(file => file.path), report.files.map(file => file.path).sort());
  assert.equal(report.exit, 0);
});

for (const [name, mutate, error] of [
  ["deleted reference", f => rmSync(join(f.coreRoot, "skills", reference)), /inventory/],
  ["truncated reference", f => f.write(join(f.coreRoot, "skills", reference), "# Synthetic receipt\n"), /Packaged resource bytes differ/],
  ["same-length changed reference", f => {
    const path = join(f.coreRoot, "skills", reference);
    const changed = readFileSync(path);
    changed[0] = changed[0] === 35 ? 33 : 35;
    f.write(path, changed);
  }, /Packaged resource bytes differ/],
  ["missing skill", f => rmSync(join(f.coreRoot, "skills", firstSkill), { recursive: true }), /inventory/],
  ["misplaced reference", f => {
    f.write(join(f.coreRoot, "skills", firstSkill, "references", "wrong.md"), readFileSync(join(f.coreRoot, "skills", reference)));
    rmSync(join(f.coreRoot, "skills", reference));
  }, /inventory/],
  ["unexpected resource", f => f.write(join(f.coreRoot, "skills", firstSkill, "examples", "extra.txt"), "extra"), /inventory/],
  ["empty reference", f => f.write(join(f.coreRoot, "skills", reference), ""), /Invalid or empty/],
  ["NUL reference", f => f.write(join(f.coreRoot, "skills", reference), "invalid\0text"), /Invalid or empty/],
  ["invalid UTF-8", f => f.write(join(f.coreRoot, "skills", reference), Buffer.from([0xff, 0xfe])), /encoded data/],
  ["oversized reference", f => f.write(join(f.coreRoot, "skills", reference), "x".repeat(512 * 1024 + 1)), /too large/],
  ["reference symlink escape", f => {
    const outside = join(f.root, "outside.md");
    f.write(outside, readFileSync(join(f.coreRoot, "skills", reference)));
    rmSync(join(f.coreRoot, "skills", reference));
    symlinkSync(outside, join(f.coreRoot, "skills", reference));
  }, /Symbolic link/],
  ["resource directory symlink escape", f => {
    cpSync(join(f.coreRoot, "skills", firstSkill, "references"), join(f.root, "outside"), { recursive: true });
    rmSync(join(f.coreRoot, "skills", firstSkill, "references"), { recursive: true });
    symlinkSync(join(f.root, "outside"), join(f.coreRoot, "skills", firstSkill, "references"));
  }, /Symbolic link/],
  ["entry outside package", f => {
    const pkg = JSON.parse(readFileSync(join(f.coreRoot, "package.json"), "utf8"));
    pkg.exports["."].import = "./../outside.js";
    f.write(join(f.coreRoot, "package.json"), JSON.stringify(pkg));
  }, /ERR_INVALID_PACKAGE_TARGET|escapes package root/],
  ["entry symlink escape", f => {
    const entry = join(f.coreRoot, "dist", "index.js");
    f.write(join(f.root, "outside.js"), readFileSync(entry));
    rmSync(entry);
    symlinkSync(join(f.root, "outside.js"), entry);
  }, /Symbolic link|escapes package root/],
  ["catalog diagnostics", f => {
    const entry = join(f.coreRoot, "dist", "index.js");
    f.write(entry, readFileSync(entry, "utf8").replace("diagnostics: []", 'diagnostics: [{ message: "invalid manifest" }]'));
  }, /catalog has diagnostics/],
  ["wrong builtin root", f => {
    const entry = join(f.coreRoot, "dist", "index.js");
    f.write(entry, readFileSync(entry, "utf8").replace('new URL("../skills"', 'new URL("../wrong-skills"'));
  }, /ENOENT/],
  ["profile requires missing skill", f => {
    const entry = join(f.coreRoot, "dist", "index.js");
    f.write(entry, readFileSync(entry, "utf8").replace(`requiredSkillIds: [${JSON.stringify(firstSkill)}]`, 'requiredSkillIds: ["missing-skill"]'));
  }, /requires unavailable skill/],
  ["loader omits linked references", f => f.write(join(f.coreRoot, "dist", "agent", "skill-tool.js"), "export async function loadLinkedSkillResources() { return []; }"), /Linked reference inventory/],
  ["loader truncates reference contents", f => {
    const entry = join(f.coreRoot, "dist", "agent", "skill-tool.js");
    f.write(entry, readFileSync(entry, "utf8").replace("return { path, body,", "return { path, body: body.slice(0, -1),"));
  }, /Linked reference bytes/],
]) {
  test(`synthetic verifier rejects ${name}`, t => {
    const f = fixture(t);
    assert.equal(verifyInstalledSkills(f.options).passed, true, "Fixture must pass before mutation");
    mutate(f);
    const report = verifyInstalledSkills(f.options);
    assert.equal(report.passed, false);
    assert.equal(report.exit, 1);
    assert.match(report.error, error);
  });
}

test("uses Node's node condition when resolving the public Core entry", t => {
  const f = fixture(t);
  const pkg = JSON.parse(readFileSync(join(f.coreRoot, "package.json"), "utf8"));
  pkg.exports["."] = { node: "./dist/missing.js", import: "./dist/index.js" };
  f.write(join(f.coreRoot, "package.json"), JSON.stringify(pkg));
  const report = verifyInstalledSkills(f.options);
  assert.equal(report.passed, false);
  assert.match(report.error, /ENOENT|missing\.js/);
});

test("Windows-mode runtime probes bind USERPROFILE to the isolated HOME", t => {
  const f = fixture(t);
  const entry = join(f.coreRoot, "dist", "index.js");
  f.write(entry, 'import assert from "node:assert/strict";\nassert.equal(process.env.USERPROFILE, process.env.HOME, "Probe profile must be isolated");\n'
    + readFileSync(entry, "utf8"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const report = verifyInstalledSkills(f.options);
    assert.equal(report.passed, true, report.error);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("rejects a normalized export target that Node forbids", t => {
  const f = fixture(t);
  const pkg = JSON.parse(readFileSync(join(f.coreRoot, "package.json"), "utf8"));
  pkg.exports["."].import = "./dist/../dist/index.js";
  f.write(join(f.coreRoot, "package.json"), JSON.stringify(pkg));
  const report = verifyInstalledSkills(f.options);
  assert.equal(report.passed, false);
  assert.match(report.error, /ERR_INVALID_PACKAGE_TARGET/);
});

test("cannot use the packaged tree as its own trusted source", t => {
  const f = fixture(t);
  const report = verifyInstalledSkills({ coreRoot: f.coreRoot, sourceSkillsRoot: join(f.coreRoot, "skills") });
  assert.equal(report.passed, false);
  assert.match(report.error, /separate trees/);
});

test("literal traversal links fail even when both trees have matching bytes", t => {
  const f = fixture(t);
  const manifest = join(firstSkill, "SKILL.md");
  for (const root of [f.sourceSkillsRoot, join(f.coreRoot, "skills")]) {
    const path = join(root, manifest);
    f.write(path, readFileSync(path, "utf8").replace("references/receipt.md", "references/../examples/receipt.txt"));
  }
  const report = verifyInstalledSkills(f.options);
  assert.equal(report.passed, false);
  assert.match(report.error, /Invalid literal skill reference/);
});

test("standalone command emits an honest failure artifact and refuses overwrite", t => {
  const f = fixture(t);
  const output = join(f.root, "report.json");
  const args = [script, "--core-root", f.coreRoot, "--output", output];
  // The command uses the real source inventory; this deliberately synthetic package differs.
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 1);
  const raw = readFileSync(output, "utf8");
  assert.equal(JSON.parse(raw).passed, false);
  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), raw);
});
