import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assemble, changePackage, fixture, SOURCE, VERSION, write } from './create-install-bundle.test.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
function harness(f, scenario = 'success', realNpm = false) {
  const bin = join(f.root, 'bin'), home = join(f.root, 'empty home'); mkdirSync(bin); mkdirSync(home);
  write(join(home, 'npmrc'), ''); write(join(home, 'global-npmrc'), '');
  write(join(bin, 'inkos'), '#!/bin/sh\necho WRONG-PATH-CLI\nexit 9\n'); chmodSync(join(bin, 'inkos'), 0o755);
  if (!realNpm) {
    write(join(bin, 'npm'), `#!${process.execPath}
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), prefix = args[args.indexOf('--prefix')+1];
appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(args)+'\\n');
if(args[0]!=='install'||args.includes('-g')||args.includes('view')) process.exit(19);
if(process.env.FIXTURE_SCENARIO==='npm-error') process.exit(7);
const names=['@actalk/inkos-core','@actalk/inkos-studio','@actalk/inkos'];
for(let i=0;i<3;i++) {
  const dir=join(prefix,'node_modules',names[i]); mkdirSync(join(dir,'..'),{recursive:true});
  cpSync(join(process.env.FIXTURE_ORIGINALS,String(i),'package'),dir,{recursive:true});
}
const cli=join(prefix,'node_modules','@actalk/inkos');
chmodSync(join(cli,'dist/index.js'),0o755);
mkdirSync(join(prefix,'node_modules','.bin')); symlinkSync('../@actalk/inkos/dist/index.js',join(prefix,'node_modules','.bin','inkos'));
const scenario=process.env.FIXTURE_SCENARIO;
function change(dir,key,value){const p=join(dir,'package.json'),m=JSON.parse(readFileSync(p));m[key]=value;writeFileSync(p,JSON.stringify(m));}
if(scenario==='missing') rmSync(join(prefix,'node_modules','@actalk/inkos-core'),{recursive:true});
if(scenario==='wrong-name') change(cli,'name','other');
if(scenario==='wrong-version') change(cli,'version','0.0.1');
if(scenario==='nested-old-core') {const nested=join(cli,'node_modules','@actalk/inkos-core');mkdirSync(join(nested,'..'),{recursive:true});cpSync(join(prefix,'node_modules','@actalk/inkos-core'),nested,{recursive:true});change(nested,'version','0.0.1');}
if(scenario==='bad-cli-version') writeFileSync(join(cli,'dist/index.js'),'console.log("0.0.1");');
if(scenario==='missing-bin') rmSync(join(prefix,'node_modules','.bin','inkos'));
if(scenario==='nonexecutable-bin') chmodSync(join(cli,'dist/index.js'),0o644);
if(scenario==='verifier-error') rmSync(join(prefix,'node_modules','@actalk/inkos-studio','dist','assets'),{recursive:true});
`);
    chmodSync(join(bin, 'npm'), 0o755);
  }
  return { PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: home,
    TMPDIR: process.env.TMPDIR ?? '/tmp', NPM_CONFIG_USERCONFIG: join(home, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'global-npmrc'), NPM_CONFIG_CACHE: join(home, 'cache'),
    FIXTURE_EVENTS: join(f.root, 'events'), FIXTURE_ORIGINALS: join(f.root, 'originals'), FIXTURE_SCENARIO: scenario };
}
function run(f, env, args, repoEntry = false) {
  return spawnSync('bash', [repoEntry ? join(scripts, 'install.sh') : join(f.output, 'install.sh'), ...args],
    { env, cwd: f.root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
}

test('Shell installs only the fixed local paths and verifies the selected prefix, including Unicode/spaces', () => {
  const f = fixture();
  try {
    assemble(f); const env = harness(f), prefix = join(f.root, '安装 新目录');
    const result = run(f, env, ['--bundle', f.output, '--prefix', prefix, '--offline'], true);
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(env.FIXTURE_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events, [['install', '--prefix', prefix, '--no-audit', '--no-fund', '--offline',
      ...[0, 1, 2].map(i => join(f.output, `package-${i}.tgz`))]]);
    const receipt = JSON.parse(readFileSync(join(prefix, '.inkos-install-status.json')));
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.installMethod, 'local-bundle');
    assert.equal(receipt.version, VERSION); assert.equal(receipt.sourceCommit, SOURCE);
    assert.equal(receipt.executable, join(prefix, 'node_modules/.bin/inkos'));
    assert(!result.stdout.includes('WRONG-PATH-CLI'));
    assert.equal(readFileSync(join(env.HOME, 'npmrc'), 'utf8'), '');
  } finally { f.cleanup(); }
});

for (const args of [[], ['--prefix'], ['--unknown', 'x'], ['--prefix', 'a', '--prefix', 'b'], ['--bundle'], ['--offline', '--offline'], ['--prefix', 'a\n']]) {
  test(`Shell rejects arguments ${JSON.stringify(args)} before npm`, () => {
    const f = fixture();
    try { assemble(f); const env = harness(f); const result = run(f, env, args); assert.notEqual(result.status, 0); assert(!existsSync(env.FIXTURE_EVENTS)); }
    finally { f.cleanup(); }
  });
}

for (const scenario of ['nonempty-prefix', 'symlink-prefix', 'symlink-parent', 'bad-schema', 'missing-tgz', 'modified-version', 'symlink-resource', 'symlink-verifier', 'newer-node-engine']) {
  test(`preflight rejects ${scenario} with zero npm calls and preserves user files`, () => {
    const f = fixture();
    try {
      if (scenario === 'newer-node-engine') changePackage(f, 0, pkg => {pkg.engines.node = '>=100.0.0';});
      assemble(f); const env = harness(f); let prefix = join(f.root, 'install');
      const user = join(f.root, 'user-owned'); mkdirSync(user); write(join(user, 'keep'), 'unchanged');
      if (scenario === 'nonempty-prefix') prefix = user;
      if (scenario === 'symlink-prefix') symlinkSync(user, prefix);
      if (scenario === 'symlink-parent') { symlinkSync(user, join(f.root, 'link')); prefix = join(f.root, 'link/install'); }
      if (scenario === 'bad-schema') { const value=JSON.parse(readFileSync(join(f.output,'bundle.json')));value.schemaVersion=2;write(join(f.output,'bundle.json'),JSON.stringify(value)); }
      if (scenario === 'missing-tgz') rmSync(join(f.output, 'package-0.tgz'));
      if (scenario === 'modified-version') { const value=JSON.parse(readFileSync(join(f.output,'bundle.json')));value.version='9.0.0';write(join(f.output,'bundle.json'),JSON.stringify(value)); }
      if (scenario === 'symlink-resource') symlinkSync(user, join(f.output, 'packages/core/skills/escape'));
      if (scenario === 'symlink-verifier') { rmSync(join(f.output,'verifiers/verify-installed-release.mjs'));symlinkSync(join(scripts,'verify-installed-release.mjs'),join(f.output,'verifiers/verify-installed-release.mjs')); }
      const result = run(f, env, ['--prefix', prefix]);
      assert.notEqual(result.status, 0); assert(!existsSync(env.FIXTURE_EVENTS));
      assert.equal(readFileSync(join(user, 'keep'), 'utf8'), 'unchanged');
      assert(!existsSync(join(user, '.inkos-install-status.json')));
    } finally { f.cleanup(); }
  });
}

for (const scenario of ['npm-error', 'missing', 'wrong-name', 'wrong-version', 'nested-old-core', 'bad-cli-version', 'missing-bin', 'nonexecutable-bin', 'verifier-error']) {
  test(`${scenario} remains a failed installation and never reports success`, () => {
    const f = fixture();
    try {
      assemble(f); const env = harness(f, scenario), prefix = join(f.root, 'install');
      const result = run(f, env, ['--prefix', prefix]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(readFileSync(join(prefix, '.inkos-install-status.json'))).status, 'failed');
      assert(!result.stdout.includes('Installed '));
      assert.equal(readFileSync(env.FIXTURE_EVENTS, 'utf8').trim().split('\n').length, 1);
    } finally { f.cleanup(); }
  });
}

test('real Shell and npm --offline install self-contained fixture tgz, then run the original release verifier', () => {
  const f = fixture();
  try {
    assemble(f); const env = harness(f, 'success', true), prefix = join(f.root, 'actual npm 安装');
    const result = run(f, env, ['--prefix', prefix, '--offline']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(join(prefix, '.inkos-install-release.json')));
    assert.equal(report.passed, true); assert.equal(report.expectedVersion, VERSION);
    const receipt = JSON.parse(readFileSync(join(prefix, '.inkos-install-status.json')));
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.provenanceKind, 'fixture');
    assert(report.checks.some(check => check.id === 'cli.version' && check.stdout.trim() === VERSION));
    assert(!result.stdout.includes('WRONG-PATH-CLI'));
  } finally { f.cleanup(); }
});
