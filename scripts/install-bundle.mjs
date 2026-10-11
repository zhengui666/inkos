// Shared preflight for the local bundle producer and installer. No registry discovery.
import { spawnSync } from 'node:child_process';
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const PACKAGE_NAMES = Object.freeze(['@actalk/inkos-core', '@actalk/inkos-studio', '@actalk/inkos']);
export const VERIFIERS = Object.freeze(['verify-installed-release.mjs', 'verify-installed-studio.mjs', 'verify-installed-skills.mjs']);
const fail = message => { throw new Error(message); };
const controls = /[\x00-\x1f\x7f]/;

export function parseOptions(argv, valueKeys, flagKeys = []) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if ((!valueKeys.includes(key) && !flagKeys.includes(key)) || key in options) fail(`Unknown or duplicate argument: ${key}`);
    if (flagKeys.includes(key)) { options[key] = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--') || controls.test(value)) fail(`Missing or invalid value: ${key}`);
    options[key] = value;
  }
  return options;
}

export function semver(version) {
  if (typeof version !== 'string') fail('Invalid SemVer');
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  const pre = match?.[4]?.split('.') ?? [];
  if (!match || match[0] !== version || pre.some(id => /^[0-9]+$/.test(id) && id.length > 1 && id[0] === '0')) fail(`Invalid SemVer: ${version}`);
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function compareVersions(a, b) {
  const left = semver(a), right = semver(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^[0-9]+$/.test(x), yn = /^[0-9]+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || controls.test(value) || value.includes('\\') || isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) fail(`Unsafe relative path: ${value}`);
  return value;
}

// Refuse symlinks in every existing ancestor, including the final file/directory.
export function noSymlinks(path) {
  const full = resolve(path);
  if (controls.test(full)) fail('Path contains control characters');
  let current = parse(full).root;
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (info.isSymbolicLink()) fail(`Symbolic link is not allowed: ${current}`);
  }
  return full;
}

export function containedFile(root, name) {
  const path = noSymlinks(join(root, safeRelative(name)));
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !lstatSync(path).isFile()) fail(`Not a contained file: ${name}`);
  return path;
}

function text(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function tarString(bytes) { return text(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0))); }
function octal(bytes) {
  const raw = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(raw)) fail('Invalid tar numeric field');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) fail('Tar numeric field is too large');
  return value;
}

// Inspect the archive without extracting anything or evaluating package code.
export function packedManifest(path) {
  noSymlinks(path);
  if (!lstatSync(path).isFile() || lstatSync(path).size > 64 * 1024 * 1024) fail('Invalid or oversized tarball');
  const data = gunzipSync(readFileSync(path), { maxOutputLength: 128 * 1024 * 1024 });
  let offset = 0, pending = {}, manifest;
  const names = new Set();
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (data.length - offset < 1024 || !data.subarray(offset).every(byte => byte === 0) || Object.keys(pending).length) fail('Truncated tar trailer');
      if (!manifest) fail('Missing package/package.json');
      return manifest;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(header.subarray(148, 156))) fail('Invalid tar header checksum');
    const type = String.fromCharCode(header[156]);
    const prefix = tarString(header.subarray(345, 500));
    const headerName = `${prefix ? `${prefix}/` : ''}${tarString(header.subarray(0, 100))}`;
    const size = octal(header.subarray(124, 136));
    const end = offset + 512 + size;
    if (end > data.length) fail('Truncated tar entry');
    const body = data.subarray(offset + 512, end);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      if (Object.keys(pending).length) fail('Repeated tar extended header');
      let start = 0;
      while (start < body.length) {
        const space = body.indexOf(32, start);
        if (space < 0) fail('Invalid tar extended header');
        const lengthText = text(body.subarray(start, space));
        const length = Number(lengthText);
        if (!/^[1-9][0-9]*$/.test(lengthText) || !Number.isSafeInteger(length) || length <= space - start + 1 || start + length > body.length || body[start + length - 1] !== 10) fail('Invalid tar extended record');
        const record = text(body.subarray(space + 1, start + length - 1));
        const split = record.indexOf('=');
        if (split <= 0 || record.slice(0, split) in pending) fail('Invalid or duplicate tar attribute');
        pending[record.slice(0, split)] = record.slice(split + 1);
        start += length;
      }
      if ('linkpath' in pending) fail('Unsupported tar extended attribute');
      continue;
    }
    if (!['0', '\0', '5'].includes(type)) fail('Links and special tar entries are not allowed');
    if ('size' in pending && pending.size !== String(size)) fail('Unsupported tar extended size');
    const name = (pending.path ?? headerName).replace(/\/$/, '');
    pending = {};
    safeRelative(name);
    if ((name !== 'package' && !name.startsWith('package/')) || names.has(name)) fail(`Unsafe or duplicate tar entry: ${name}`);
    names.add(name);
    if (name === 'package/package.json') {
      if (type === '5' || size > 2 * 1024 * 1024) fail('Invalid package manifest entry');
      manifest = JSON.parse(text(body));
    }
  }
  fail('Truncated tarball');
}

export function packageSet(packages) {
  if (packages.length !== 3 || new Set(packages.map(pkg => pkg.name)).size !== 3
    || PACKAGE_NAMES.some(name => !packages.some(pkg => pkg.name === name))) fail('Exactly the three Inkos packages are required');
  const version = packages[0].version;
  semver(version);
  let minimum = '22.19.0';
  const packageEngines = {};
  for (const pkg of packages) {
    if (pkg.version !== version) fail('Package versions must match exactly');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg[field] ?? {};
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) fail(`Invalid ${field}`);
      for (const [name, value] of Object.entries(deps)) {
        if (typeof value !== 'string' || value.includes('workspace:')) fail('Runtime workspace dependency is not allowed');
        if (PACKAGE_NAMES.includes(name) && value !== version) fail(`Internal dependency must be exact: ${pkg.name} -> ${name}`);
      }
    }
    for (const name of pkg.name === '@actalk/inkos' ? PACKAGE_NAMES.slice(0, 2) : pkg.name === '@actalk/inkos-studio' ? [PACKAGE_NAMES[0]] : []) {
      if (pkg.dependencies?.[name] !== version) fail(`Missing exact dependency: ${pkg.name} -> ${name}`);
    }
    const requirement = pkg.engines?.node;
    if (typeof requirement !== 'string' || !/^>=([0-9]+\.[0-9]+\.[0-9]+)$/.test(requirement)) fail(`Unsupported Node engine: ${pkg.name}`);
    const lower = requirement.slice(2);
    semver(lower);
    if (compareVersions(lower, '22.19.0') < 0) fail('Node engine must not be below 22.19.0');
    if (compareVersions(lower, minimum) > 0) minimum = lower;
    packageEngines[pkg.name] = pkg.engines;
  }
  return { version, runtimeRequirements: { bash: '>=3.2', node: `>=${minimum}`, npm: 'required', tar: 'required', packageEngines } };
}

function validateResourceTree(directory) {
  noSymlinks(directory);
  if (!lstatSync(directory).isDirectory()) fail('Missing verifier reference skills');
  for (const name of readdirSync(directory)) {
    safeRelative(name);
    const path = noSymlinks(join(directory, name)), info = lstatSync(path);
    if (info.isDirectory()) validateResourceTree(path);
    else if (!info.isFile()) fail('Special verifier resource is not allowed');
  }
}

export function validateBundle(directory) {
  const root = noSymlinks(directory);
  if (!lstatSync(root).isDirectory()) fail('Bundle must be a directory');
  const bundle = JSON.parse(readFileSync(containedFile(root, 'bundle.json'), 'utf8'));
  if (bundle.schemaVersion !== 1 || bundle.generatorVersion !== 1 || typeof bundle.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(bundle.sourceCommit)
    || !['production', 'fixture'].includes(bundle.provenance?.kind) || !Array.isArray(bundle.packages) || bundle.packages.length !== 3) fail('Invalid bundle schema');
  const provenance = bundle.provenance;
  if (provenance.sourceCommit !== bundle.sourceCommit || provenance.schemaVersion !== 1 || provenance.build?.exit !== 0 || provenance.pack?.exit !== 0
    || provenance.build.sourceCommit !== bundle.sourceCommit || provenance.pack.sourceCommit !== bundle.sourceCommit
    || !Array.isArray(provenance.packages) || !isDeepStrictEqual(provenance.packages, bundle.packages)) fail('Bundle provenance disagrees with selected packages');
  const seen = new Set();
  const paths = bundle.packages.map(item => {
    if (!item || seen.has(item.file)) fail('Duplicate bundle package file');
    seen.add(item.file);
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*\.tgz$/.test(item.file)) fail('Unsafe tarball filename');
    return containedFile(root, item.file);
  });
  const packages = paths.map(packedManifest);
  const contract = packageSet(packages);
  if (bundle.version !== contract.version || !isDeepStrictEqual(bundle.runtimeRequirements, contract.runtimeRequirements)) fail('Bundle version or engines disagree with tarballs');
  packages.forEach((pkg, i) => {
    if (pkg.name !== bundle.packages[i].name || pkg.version !== bundle.packages[i].version) fail('Bundle identity disagrees with tarball');
  });
  for (const file of ['install.sh', 'install-bundle.mjs', ...VERIFIERS.map(name => `verifiers/${name}`)]) containedFile(root, file);
  validateResourceTree(join(root, 'packages/core/skills'));
  return { root, bundle, paths };
}

function prefixPreflight(value) {
  const prefix = noSymlinks(value);
  const parent = dirname(prefix);
  if (!lstatSync(parent).isDirectory()) fail('Prefix parent must exist');
  accessSync(parent, constants.W_OK | constants.X_OK);
  if (existsSync(prefix)) {
    if (!lstatSync(prefix).isDirectory() || readdirSync(prefix).length) fail('Prefix must be a new or empty directory');
    accessSync(prefix, constants.W_OK | constants.X_OK);
  }
  return prefix;
}

export function installBundle(argv) {
  let prefix, status, claimed = false, stage = 'preflight';
  const saveStatus = () => {
    const path = noSymlinks(join(prefix, '.inkos-install-status.json'));
    if (claimed !== 'new' && !lstatSync(path).isFile()) fail('Installation status is not a regular file');
    writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, { flag: claimed === 'new' ? 'wx' : 'w' });
    claimed = true;
  };
  try {
    const options = parseOptions(argv, ['--prefix', '--bundle'], ['--offline']);
    if (!options['--prefix']) fail('--prefix is required');
    if (process.platform === 'win32') fail('This Shell installer supports POSIX hosts only');
    const { root, bundle, paths } = validateBundle(options['--bundle'] ?? dirname(fileURLToPath(import.meta.url)));
    if (compareVersions(process.versions.node, bundle.runtimeRequirements.node.slice(2)) < 0) fail(`Node ${bundle.runtimeRequirements.node} is required`);
    prefix = prefixPreflight(options['--prefix']);
    status = { schemaVersion: 1, status: 'in_progress', installMethod: 'local-bundle', version: bundle.version,
      sourceCommit: bundle.sourceCommit, provenanceKind: bundle.provenance.kind, prefix, executable: join(prefix, 'node_modules/.bin/inkos') };
    noSymlinks(prefix);
    if (!existsSync(prefix)) mkdirSync(prefix);
    else if (readdirSync(prefix).length) fail('Prefix changed after preflight');
    claimed = 'new';
    saveStatus();
    stage = 'npm';
    const args = ['install', '--prefix', prefix, '--no-audit', '--no-fund', ...(options['--offline'] ? ['--offline'] : []), ...paths];
    const install = spawnSync('npm', args, { cwd: prefix, stdio: 'inherit' });
    if (install.error || install.status !== 0) fail(`npm failed: ${install.error?.message ?? `exit ${install.status}, signal ${install.signal}`}`);
    stage = 'verification';
    noSymlinks(prefix);
    const output = join(prefix, '.inkos-install-release.json');
    const verify = spawnSync(process.execPath, [join(root, 'verifiers/verify-installed-release.mjs'), '--root', prefix,
      '--version', bundle.version, '--output', output], { cwd: prefix, stdio: 'inherit' });
    if (verify.error || verify.status !== 0) fail(`Installed release verification failed: ${verify.error?.message ?? verify.status}`);
    const report = JSON.parse(readFileSync(containedFile(prefix, '.inkos-install-release.json'), 'utf8'));
    if (report.passed !== true || report.exit !== 0 || report.expectedVersion !== bundle.version || report.root !== realpathSync(prefix)) fail('Installed release report does not confirm the selected target');
    if (realpathSync(status.executable) !== report.checks?.find(check => check.id === 'cli.bin' && check.status === 'pass')?.path) fail('Installed executable disagrees with the verified CLI');
    accessSync(status.executable, constants.X_OK);
    status.status = 'complete';
    saveStatus();
    console.log(`Installed ${bundle.version} from ${bundle.sourceCommit} (${bundle.provenance.kind}); prefix ${prefix}; executable ${status.executable}`);
    return status;
  } catch (error) {
    if (claimed) {
      status.status = 'failed'; status.stage = stage; status.error = error.message;
      try { saveStatus(); } catch (writeError) { console.error(`Could not save failure status: ${writeError.message}`); }
    }
    console.error(JSON.stringify({ status: 'failed', stage, prefix: prefix ?? null, error: error.message }));
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installBundle(process.argv.slice(2)); } catch { process.exitCode = 1; }
}
