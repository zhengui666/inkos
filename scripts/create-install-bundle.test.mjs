import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createBundle } from './create-install-bundle.mjs';
import { compareVersions, packedManifest, PACKAGE_NAMES, validateBundle } from './install-bundle.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
export const VERSION = '2.3.4-test.1';
export const SOURCE = '13107f89e2be7d9a3958e429d868e4cac4c1eaec';
export function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'inkos-local-bundle-'));
  const packDir = join(root, 'packs'); mkdirSync(packDir);
  const originals = join(root, 'originals'); mkdirSync(originals);
  const receipt = { schemaVersion: 1, kind: 'fixture', sourceCommit: SOURCE,
    build: { command: 'synthetic fixture modules; no product build', exit: 0, sourceCommit: SOURCE },
    pack: { command: 'tar -czf local fixture archives', exit: 0, sourceCommit: SOURCE }, packages: [] };
  const dirs = PACKAGE_NAMES.map((name, i) => {
    const dir = join(originals, String(i), 'package'); mkdirSync(dir, { recursive: true });
    const pkg = { name, version: VERSION, type: 'module', engines: { node: '>=22.19.0' }, dependencies: {} };
    if (i === 0) {
      pkg.main = 'dist/index.js'; pkg.exports = { '.': { import: './dist/index.js', types: './dist/index.d.ts' } };
      cpSync(join(scripts, '../packages/core/skills'), join(dir, 'skills'), { recursive: true });
      write(join(dir, 'dist/index.d.ts'), 'export declare const fixture: boolean;');
      write(join(dir, 'dist/index.js'), String.raw`
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../skills', import.meta.url));
export function parseAgentSkillDocument(raw, {skillPath, source}) {
  const parsed = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const id = parsed[1].match(/^name: (.+)$/m)[1].trim();
  const description = parsed[1].match(/^description: (.+)$/m)[1].trim();
  return {id, name:id, description, source, baseDir:dirname(skillPath), body:parsed[2]};
}
export async function loadBuiltinAgentSkills() {
  return {diagnostics:[], skills:readdirSync(root).sort().map(id => {
    const skillPath = join(root,id,'SKILL.md');
    return parseAgentSkillDocument(readFileSync(skillPath,'utf8'),{skillPath,source:'builtin'});
  })};
}
export function builtInWorkProfiles() { return [{id:'fixture',requiredSkillIds:['inkos-long-writing']}]; }
`);
      write(join(dir, 'dist/agent/skill-tool.js'), String.raw`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function loadLinkedSkillResources(skill) {
  const paths = new Set();
  for (const match of skill.body.matchAll(/\x60((?:references|examples)\/[^\x60\n]+)\x60|\[[^\]\n]*\]\(((?:references|examples)\/[^)\n]+)\)/g)) {
    const path = match[1] ?? match[2]; if (/\.(?:md|txt)$/i.test(path)) paths.add(path);
  }
  return [...paths].sort().map(path => {const body=readFileSync(join(skill.baseDir,path),'utf8');return {path,body,charStart:0,charEnd:body.length};});
}
`);
    } else if (i === 1) {
      pkg.main = 'dist/api/index.js'; pkg.dependencies[PACKAGE_NAMES[0]] = VERSION;
      write(join(dir, 'dist/api/index.js'), 'export const fixture = true;');
      write(join(dir, 'dist/index.html'), '<!doctype html><title>Fixture</title>');
      write(join(dir, 'dist/assets/app.js'), 'console.log("fixture");');
    } else {
      pkg.bin = { inkos: 'dist/index.js' };
      pkg.dependencies[PACKAGE_NAMES[0]] = VERSION; pkg.dependencies[PACKAGE_NAMES[1]] = VERSION;
      write(join(dir, 'dist/index.js'), `#!/usr/bin/env node\nconst arg=process.argv[2];\nif(arg==='--version') console.log(${JSON.stringify(VERSION)});\nelse if(arg==='--help') console.log('Usage: inkos [options] [command]\\n--help\\nCommands:');\nelse {console.error("error: unknown command '"+arg+"'");process.exitCode=1;}\n`);
    }
    write(join(dir, 'package.json'), JSON.stringify(pkg));
    receipt.packages.push({ name, version: VERSION, file: `package-${i}.tgz` });
    return dir;
  });
  const provenance = join(root, 'provenance.json');
  const f = { root, packDir, dirs, receipt, provenance, output: join(root, 'bundle 空格'),
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
  repack(f);
  return f;
}

export function repack(f) {
  f.dirs.forEach((dir, i) => {
    const result = spawnSync('tar', ['-czf', join(f.packDir, f.receipt.packages[i].file), '-C', dirname(dir), 'package'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
  write(f.provenance, JSON.stringify(f.receipt));
}

export function assemble(f) { return createBundle({ packDir: f.packDir, output: f.output, provenance: f.provenance }); }
export function changePackage(f, index, change) {
  const path = join(f.dirs[index], 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8'));
  change(pkg); write(path, JSON.stringify(pkg)); repack(f);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('assembles three actual manifests, engines, provenance and unchanged verifier resources', () => {
    const f = fixture();
    try {
      const result = assemble(f), checked = validateBundle(f.output);
      assert.equal(result.version, VERSION); assert.equal(result.sourceCommit, SOURCE);
      assert.equal(checked.paths.length, 3); assert.equal(result.runtimeRequirements.node, '>=22.19.0');
      for (const name of ['verify-installed-release.mjs', 'verify-installed-studio.mjs', 'verify-installed-skills.mjs']) {
        assert(readFileSync(join(f.output, 'verifiers', name)).equals(readFileSync(join(scripts, name))));
      }
      assert(!existsSync(join(f.output, 'node_modules')));
      assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('.inkos-bundle-')), []);
      assert.throws(() => assemble(f), /already exists/);
    } finally { f.cleanup(); }
  });

  test('accepts equivalent provenance and runtime objects with reordered JSON keys', () => {
    const f = fixture();
    try {
      f.receipt.packages = f.receipt.packages.map(({name, version, file}) => ({file, version, name}));
      write(f.provenance, JSON.stringify(f.receipt));
      assemble(f);
      const path = join(f.output, 'bundle.json'), bundle = JSON.parse(readFileSync(path));
      bundle.runtimeRequirements = Object.fromEntries(Object.entries(bundle.runtimeRequirements).reverse());
      write(path, JSON.stringify(bundle));
      assert.equal(validateBundle(f.output).bundle.version, VERSION);
    } finally { f.cleanup(); }
  });

  test('accepts real npm pack archives without package lifecycle scripts or network', () => {
    const f = fixture();
    try {
      const env = {...process.env, HOME: f.root, NPM_CONFIG_OFFLINE: 'true',
        NPM_CONFIG_CACHE: join(f.root, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(f.root, 'empty-npmrc'),
        NPM_CONFIG_GLOBALCONFIG: join(f.root, 'empty-global-npmrc')};
      for (let i = 0; i < f.dirs.length; i++) {
        const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', f.packDir],
          {cwd: f.dirs[i], env, encoding: 'utf8', timeout: 30_000});
        assert.equal(result.status, 0, result.stderr);
        f.receipt.packages[i].file = JSON.parse(result.stdout)[0].filename;
      }
      f.receipt.pack.command = 'npm pack --ignore-scripts --json on synthetic fixture packages';
      write(f.provenance, JSON.stringify(f.receipt));
      assemble(f);
      assert.equal(validateBundle(f.output).bundle.provenance.kind, 'fixture');
    } finally { f.cleanup(); }
  });

  for (const [label, change] of [
    ['wrong name', pkg => { pkg.name = 'wrong'; }],
    ['different version', pkg => { pkg.version = '2.3.5'; }],
    ['invalid version', pkg => { pkg.version = '02.3.4'; }],
    ['old engine', pkg => { pkg.engines.node = '>=22.16.0'; }],
    ['missing engine', pkg => { delete pkg.engines; }],
    ['unsupported engine range', pkg => { pkg.engines.node = '^22.19.0'; }],
    ['workspace dependency', pkg => { pkg.dependencies.extra = 'workspace:*'; }],
  ]) test(`rejects ${label} before creating output`, () => {
    const f = fixture();
    try { changePackage(f, 0, change); assert.throws(() => assemble(f)); assert(!existsSync(f.output)); }
    finally { f.cleanup(); }
  });

  for (const specifier of ['latest', '^2.3.4', '2.3.5', 'workspace:*']) test(`rejects internal dependency ${specifier}`, () => {
    const f = fixture();
    try { changePackage(f, 2, pkg => { pkg.dependencies[PACKAGE_NAMES[0]] = specifier; }); assert.throws(() => assemble(f)); }
    finally { f.cleanup(); }
  });

  for (const scenario of ['missing', 'duplicate-name', 'duplicate-file', 'bad-json', 'bad-gzip', 'symlink', 'symlink-entry', 'duplicate-entry', 'bad-provenance', 'escaped-file', 'existing-output']) {
    test(`rejects ${scenario} without publishing a manifest`, () => {
      const f = fixture();
      try {
        if (scenario === 'missing') rmSync(join(f.packDir, 'package-0.tgz'));
        if (scenario === 'duplicate-name') changePackage(f, 1, pkg => { pkg.name = PACKAGE_NAMES[0]; });
        if (scenario === 'duplicate-file') { f.receipt.packages[1].file = f.receipt.packages[0].file; write(f.provenance, JSON.stringify(f.receipt)); }
        if (scenario === 'bad-json') { write(join(f.dirs[0], 'package.json'), '{'); repack(f); }
        if (scenario === 'bad-gzip') write(join(f.packDir, 'package-0.tgz'), 'not gzip');
        if (scenario === 'symlink') { rmSync(join(f.packDir, 'package-0.tgz')); symlinkSync(join(f.packDir, 'package-1.tgz'), join(f.packDir, 'package-0.tgz')); }
        if (scenario === 'symlink-entry') { symlinkSync('/outside', join(f.dirs[0], 'escape')); repack(f); }
        if (scenario === 'duplicate-entry') {
          const result = spawnSync('tar', ['-czf', join(f.packDir, 'package-0.tgz'), '-C', dirname(f.dirs[0]), 'package', 'package/package.json']);
          assert.equal(result.status, 0);
        }
        if (scenario === 'bad-provenance') { f.receipt.build.sourceCommit = 'other'; write(f.provenance, JSON.stringify(f.receipt)); }
        if (scenario === 'escaped-file') { f.receipt.packages[0].file = '../outside.tgz'; write(f.provenance, JSON.stringify(f.receipt)); }
        if (scenario === 'existing-output') { mkdirSync(f.output); write(join(f.output, 'user-file'), 'keep'); }
        assert.throws(() => assemble(f));
        assert(!existsSync(join(f.output, 'bundle.json')));
        if (scenario === 'existing-output') assert.equal(readFileSync(join(f.output, 'user-file'), 'utf8'), 'keep');
      } finally { f.cleanup(); }
    });
  }

  test('SemVer handles build, prerelease and arbitrary numeric precision', () => {
    for (const [a, b] of [['1.0.0-9', '1.0.0-10'], ['1.0.0-1', '1.0.0-alpha'], ['1.0.0-alpha', '1.0.0-alpha.1'],
      ['1.0.0-alpha.1', '1.0.0-alpha.beta'], ['1.0.0-beta', '1.0.0-rc.1'], ['1.0.0-rc.1', '1.0.0'],
      ['9007199254740992.0.0', '9007199254740993.0.0']]) {
      assert.equal(compareVersions(a, b), -1); assert.equal(compareVersions(b, a), 1);
    }
    assert.equal(compareVersions('1.0.0+001', '1.0.0+other'), 0);
    for (const value of ['1.0.0-01', '1.0.0-', '1.0.0+a..b', '1.0.0\n', '1.0.0;echo']) assert.throws(() => compareVersions(value, '1.0.0'));
  });
}
