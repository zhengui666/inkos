// Assemble existing same-source local packs. Never builds, installs, or publishes.
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containedFile, noSymlinks, packedManifest, packageSet, parseOptions, safeRelative, validateBundle, VERIFIERS } from './install-bundle.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));

function copyTree(source, target) {
  noSymlinks(source);
  if (!lstatSync(source).isDirectory()) throw new Error('Expected a source resource directory');
  mkdirSync(target);
  for (const name of readdirSync(source)) {
    safeRelative(name);
    const from = noSymlinks(join(source, name)), to = join(target, name);
    const info = lstatSync(from);
    if (info.isDirectory()) copyTree(from, to);
    else if (info.isFile()) copyFileSync(from, to);
    else throw new Error('Special source resources are not allowed');
  }
}

export function createBundle({ packDir, output, provenance }) {
  const source = noSymlinks(packDir), target = noSymlinks(output);
  // lstat catches existing dangling symlinks as well as ordinary output directories.
  try { lstatSync(target); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const receipt = JSON.parse(readFileSync(noSymlinks(provenance), 'utf8'));
  if (receipt.schemaVersion !== 1 || typeof receipt.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(receipt.sourceCommit) || !['fixture', 'production'].includes(receipt.kind)
    || !Array.isArray(receipt.packages) || receipt.packages.length !== 3
    || receipt.build?.exit !== 0 || receipt.pack?.exit !== 0
    || receipt.build.sourceCommit !== receipt.sourceCommit || receipt.pack.sourceCommit !== receipt.sourceCommit
    || typeof receipt.build.command !== 'string' || !receipt.build.command || typeof receipt.pack.command !== 'string' || !receipt.pack.command) throw new Error('Invalid same-source build/pack provenance');
  const files = receipt.packages.map(item => item?.file);
  if (new Set(files).size !== 3 || files.some(file => typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*\.tgz$/.test(file))) throw new Error('Invalid or duplicate pack filenames');
  const inputs = files.map(file => containedFile(source, file));
  const packages = inputs.map(packedManifest);
  const contract = packageSet(packages);
  packages.forEach((pkg, i) => {
    if (pkg.name !== receipt.packages[i].name || pkg.version !== receipt.packages[i].version) throw new Error('Pack provenance disagrees with actual package identity');
  });
  let temporary, reservation;
  try {
    temporary = mkdtempSync(join(dirname(target), '.inkos-bundle-'));
    inputs.forEach((file, i) => copyFileSync(file, join(temporary, files[i])));
    for (const name of ['install.sh', 'install-bundle.mjs']) copyFileSync(containedFile(scripts, name), join(temporary, name));
    mkdirSync(join(temporary, 'verifiers'));
    for (const name of VERIFIERS) copyFileSync(containedFile(scripts, name), join(temporary, 'verifiers', name));
    mkdirSync(join(temporary, 'packages/core'), { recursive: true });
    copyTree(join(scripts, '../packages/core/skills'), join(temporary, 'packages/core/skills'));
    const bundle = { schemaVersion: 1, generatorVersion: 1, sourceCommit: receipt.sourceCommit,
      version: contract.version, runtimeRequirements: contract.runtimeRequirements,
      packages: packages.map((pkg, i) => ({ name: pkg.name, version: pkg.version, file: files[i] })),
      provenance: receipt };
    writeFileSync(join(temporary, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(temporary, 'INSTALL.txt'), `Local Inkos bundle ${bundle.version}\nSource identifier: ${bundle.sourceCommit}\nProvenance kind: ${receipt.kind}\n\nBash 3.2+, Node ${contract.runtimeRequirements.node}, npm and standard tar are required.\nRun: bash install.sh --prefix /absolute/new/directory [--offline]\nThird-party runtime dependencies use npm network/cache; this is not a fully offline dependency bundle.\nThe source commit is provenance, not a content checksum or signature.\nInstallation receipt: <prefix>/.inkos-install-status.json (status must be complete).\nOn failure, keep the diagnostic prefix and use another new directory for a retry.\nTo update, install a later same-source bundle in another new prefix, verify it, and use its executable.\nThe existing inkos update command tracks npm latest and does not update this local combination.\nNo assets have been uploaded and no remote download URL is provided.\n`);
    validateBundle(temporary);
    // Reserve the destination rather than allowing rename to replace a concurrently created directory.
    mkdirSync(target);
    reservation = lstatSync(target);
    renameSync(temporary, target);
    reservation = undefined;
    temporary = undefined;
    console.log(`Created local bundle ${bundle.version} (${receipt.kind}): ${target}`);
    return bundle;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (reservation) {
      const actual = lstatSync(target);
      if (actual.ino === reservation.ino && actual.dev === reservation.dev) rmdirSync(target);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseOptions(process.argv.slice(2), ['--pack-dir', '--output', '--provenance']);
    if (Object.keys(args).length !== 3) throw new Error('--pack-dir, --output and --provenance are required');
    createBundle({ packDir: args['--pack-dir'], output: args['--output'], provenance: args['--provenance'] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
