import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const gateCondition = "${{ !cancelled() && steps.installed-package.outcome == 'success' }}";
const finalCondition = "${{ !contains(github.ref_name, '-') }}";

// Inspect the checked-in workflows' block style without installing a YAML parser.
// Fixed indentation and exact commands make unsupported rewrites fail closed.
function blocks(text, pattern) {
  const matches = [...text.matchAll(pattern)];
  return matches.map((match, i) => [match[1], text.slice(match.index, matches[i + 1]?.index)]);
}

function job(source, name) {
  const matches = blocks(source, /^  ([\w-]+):\s*$/gm).filter(([key]) => key === name);
  assert.equal(matches.length, 1, `Expected one ${name} job`);
  return matches[0][1];
}

function field(text, name, indent) {
  const matches = [...text.matchAll(new RegExp(`^${' '.repeat(indent)}${name}: (.+)$`, 'gm'))];
  assert.ok(matches.length <= 1, `Duplicate ${name} field`);
  return matches[0]?.[1];
}

function steps(text) {
  return blocks(text, /^      - (.+)$/gm).map(([, block]) => block.replace(/^      - /, '        '));
}

function run(step) {
  const value = field(step, 'run', 8);
  if (value !== '|') return value;
  return step.split(/^        run: \|\n/m)[1].split(/^        \S/m)[0]
    .replace(/^          /gm, '').trim();
}

function assertGates(source, name) {
  const text = job(source, name);
  const entries = steps(text);
  assert.equal(field(text, 'if', 4), name === 'verify-release' ? finalCondition : undefined);
  assert.equal(field(text, 'continue-on-error', 4), undefined);
  const installers = entries.filter(step => field(step, 'id', 8) === 'installed-package');
  assert.equal(installers.length, 1);
  const installer = installers[0];
  assert.equal(field(installer, 'if', 8), undefined);
  assert.match(run(installer), /^set -euo pipefail\n/);
  assert.match(run(installer), /echo "INSTALLED_ROOT=\$INSTALLED_ROOT" >> "\$GITHUB_ENV"/);
  assert.match(run(installer), /echo "EXPECTED_VERSION=\$EXPECTED_(?:VERSION|CANARY|RELEASE)" >> "\$GITHUB_ENV"/);
  assert.match(run(installer), /INSTALLED_EVIDENCE_DIR=\$\(mktemp -d "\$RUNNER_TEMP\/inkos-evidence\.XXXXXX"\)/);
  assert.match(run(installer), /echo "INSTALLED_EVIDENCE_DIR=\$INSTALLED_EVIDENCE_DIR" >> "\$GITHUB_ENV"/);
  assert.match(run(installer), /cd "\$INSTALLED_ROOT"\nnpm init -y\nnpm install /);
  assert.ok(entries.some(step => field(step, 'uses', 8) === 'actions/checkout@v4'));
  if (['verify-canary', 'verify-release'].includes(name)) {
    const checkout = entries.find(step => field(step, 'uses', 8) === 'actions/checkout@v4');
    assert.equal(field(checkout, 'ref', 10), '${{ github.sha }}');
    assert.ok(entries.indexOf(checkout) < entries.indexOf(installer));
  }

  for (const [script, args] of [
    ['release', '--version "$EXPECTED_VERSION" --output "$INSTALLED_EVIDENCE_DIR/release.json"'],
    ['studio', '--output "$INSTALLED_EVIDENCE_DIR/studio.json"'],
  ]) {
    const matches = entries.filter(step => run(step)?.includes(`scripts/verify-installed-${script}.mjs`));
    assert.equal(matches.length, 1, `Expected one installed ${script} check`);
    assert.equal(run(matches[0]), `node scripts/verify-installed-${script}.mjs --root "$INSTALLED_ROOT" ${args}`);
    assert.equal(field(matches[0], 'if', 8), gateCondition);
    assert.ok(entries.indexOf(matches[0]) > entries.indexOf(installer));
  }
  for (const entry of entries) assert.equal(field(entry, 'continue-on-error', 8), undefined);
  const upload = entries.filter(step => field(step, 'uses', 8) === 'actions/upload-artifact@v4');
  assert.equal(upload.length, 1);
  assert.equal(field(upload[0], 'if', 8), 'always()');
  assert.equal(field(upload[0], 'path', 10), '${{ runner.temp }}/inkos-evidence.*/*.json');
  assert.ok(entries.indexOf(upload[0]) > entries.findLastIndex(step => run(step)?.includes('scripts/verify-installed-')));
}

function assertLocalInstall(source, name) {
  const text = job(source, name);
  const entries = steps(text);
  const commands = entries.map(run);
  const install = run(entries.find(step => field(step, 'id', 8) === 'installed-package'));
  assert.ok(commands.includes('pnpm install --frozen-lockfile'));
  assert.ok(commands.includes('pnpm build'));
  assert.ok(commands.indexOf('pnpm build') < commands.indexOf(install));
  assert.match(install, /INSTALLED_ROOT=\$\(mktemp -d "\$RUNNER_TEMP\/inkos-installed\.XXXXXX"\)/);
  assert.match(install, /PACK_DIR=\$\(mktemp -d "\$RUNNER_TEMP\/inkos-pack\.XXXXXX"\)/);
  assert.match(install, /\['core', 'studio', 'cli'\].map/);
  assert.match(install, /!versions\[0\] \|\| !versions.every\(version => version === versions\[0\]\)/);
  assert.match(install, /for pkg in core studio cli; do\n  \(cd "packages\/\$pkg" && npm pack --pack-destination "\$PACK_DIR"\)\ndone/);
  for (const [variable, filename] of [['CORE', 'actalk-inkos-core'], ['STUDIO', 'actalk-inkos-studio'], ['CLI', 'actalk-inkos']]) {
    assert.ok(install.includes(`${variable}_TGZ="$PACK_DIR/${filename}-$EXPECTED_VERSION.tgz"`));
    assert.ok(install.includes(`test -f "$${variable}_TGZ"`));
  }
  const installs = install.match(/^npm install .+$/gm);
  assert.deepEqual(installs, ['npm install --no-audit --no-fund "$CORE_TGZ" "$STUDIO_TGZ" "$CLI_TGZ"']);
  assert.doesNotMatch(install, /npm (?:link|install .*@actalk\/)|workspace:|--ignore-scripts|\|\| true/);
}

function assertDependencies(source) {
  const needs = {
    'smoke-test': 'test',
    'publish-canary': 'smoke-test',
    'verify-canary': 'publish-canary',
    'publish-release': '[publish-canary, verify-canary]',
    'verify-release': '[publish-canary, publish-release]',
    'github-release': 'verify-release',
  };
  for (const [name, expected] of Object.entries(needs)) {
    const text = job(source, name);
    assert.equal(field(text, 'needs', 4), expected, `${name} must retain its blocking predecessors`);
    assert.equal(field(text, 'if', 4), ['publish-release', 'verify-release', 'github-release'].includes(name) ? finalCondition : undefined);
    assert.equal(field(text, 'continue-on-error', 4), undefined);
  }
}

for (const [source, name] of [[ci, 'installed-package-smoke'], [release, 'smoke-test'], [release, 'verify-canary'], [release, 'verify-release']]) {
  test(`${name} runs both installed checks as blocking gates and always uploads evidence`, () => assertGates(source, name));
}

test('CI and pre-canary smoke install the same three exact local tarballs', () => {
  assertLocalInstall(ci, 'installed-package-smoke');
  assertLocalInstall(release, 'smoke-test');
  const localRun = source => run(steps(job(source, source === ci ? 'installed-package-smoke' : 'smoke-test')).find(step => field(step, 'id', 8) === 'installed-package'));
  assert.equal(localRun(ci), localRun(release));
  const text = job(ci, 'installed-package-smoke');
  assert.equal(field(text, 'runs-on', 4), 'ubuntu-latest');
  assert.match(text, /^        node-version: \[22, 24\]$/m);
  assert.match(text, /^          node-version: \$\{\{ matrix.node-version \}\}$/m);
});

test('release publishing and GitHub release cannot bypass the gate dependency chain', () => assertDependencies(release));

for (const [name, expected, actual, tag] of [
  ['verify-canary', 'EXPECTED_CANARY', 'ACTUAL_CANARY', 'canary'],
  ['verify-release', 'EXPECTED_RELEASE', 'ACTUAL_LATEST', 'latest'],
]) {
  test(`${name} retains the dist-tag wait and exact registry installation before checks`, () => {
    const install = run(steps(job(release, name)).find(step => field(step, 'id', 8) === 'installed-package'));
    assert.ok(install.includes(`${expected}="\${{ needs.publish-canary.outputs.${tag === 'canary' ? 'canary' : 'release'}_version }}"`));
    assert.match(install, /for _ in 1 2 3 4 5 6; do/);
    assert.ok(install.includes(`npm view @actalk/inkos@${tag} version 2>/dev/null || true`));
    assert.match(install, /sleep 10/);
    assert.ok(install.includes(`if [ "$${actual}" != "$${expected}" ]; then`));
    assert.match(install, /exit 1/);
    assert.ok(install.includes(`npm install "@actalk/inkos@$${expected}"`));
    assert.match(install, /npx inkos --version/);
    for (const pkg of ['inkos', 'inkos-core', 'inkos-studio']) assert.ok(install.includes(`node_modules/@actalk/${pkg}/package.json`));
    assert.match(install, /test -f node_modules\/@actalk\/inkos-studio\/dist\/api\/index.js/);
    assert.match(install, /installed core import missing PipelineRunner/);
    assert.match(install, /dist\/notify\/telegram.js/);
    assert.doesNotMatch(install, /rm -rf/);
  });
}

test('existing tests, triggers and token permissions are retained', () => {
  assert.equal(ci.split('jobs:\n')[0], 'name: CI\n\non:\n  push:\n    branches: [master, main]\n  pull_request:\n    branches: [master, main]\n\n');
  assert.equal(release.split('jobs:\n')[0], 'name: Release\n\non:\n  push:\n    tags:\n      - "v*"\n\npermissions:\n  contents: write\n\n');
  assert.equal((ci.match(/permissions:/g) ?? []).length, 1);
  assert.match(job(ci, 'codex-browser'), /permissions:\n      contents: read/);
  assert.equal((release.match(/permissions:/g) ?? []).length, 1);
  assert.equal((release.match(/NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/g) ?? []).length, 6);
  for (const [source, name] of [[ci, 'build-and-test'], [release, 'test']]) {
    const text = job(source, name);
    assert.match(text, /run: pnpm test/);
    assert.match(text, /run: pnpm build/);
    assert.match(text, /run: pnpm (?:--filter @actalk\/inkos-core )?typecheck/);
    assert.match(text, /run: node --test scripts\/installed-gates-workflow.test.mjs/);
  }
  assert.match(job(ci, 'build-and-test'), /verify-studio-shutdown.mjs/);
  assert.match(job(ci, 'build-and-test'), /INKOS_CODEX_INTEGRATION: '1'/);
  assert.match(job(ci, 'codex-browser'), /playwright test --config=playwright.codex.config.ts codex-settings.spec.ts/);
  assert.match(job(ci, 'codex-browser'), /playwright test --config=playwright.creation.config.ts/);
  assert.match(job(ci, 'verify-pack'), /FAIL: \$pkg tarball still contains workspace: protocol/);
  const smoke = job(release, 'smoke-test');
  assert.match(smoke, /node packages\/cli\/dist\/index.js --help/);
  assert.match(smoke, /node packages\/cli\/dist\/index.js --version/);
  assert.match(smoke, /core import OK/);
  assert.match(smoke, /FAIL: \$pkg tarball still contains workspace: protocol/);
});

for (const [label, mutate, check] of [
  ['removed canary predecessor', text => text.replace('needs: [publish-canary, verify-canary]', 'needs: publish-canary'), assertDependencies],
  ['removed release predecessor', text => text.replace('needs: verify-release', 'needs: publish-release'), assertDependencies],
  ['always-run publishing', text => text.replace(finalCondition, '${{ always() }}'), assertDependencies],
  ['nonblocking job', text => text.replace('  verify-canary:\n', '  verify-canary:\n    continue-on-error: true\n'), text => assertGates(text, 'verify-canary')],
  ['nonblocking check', text => text.replace('      - name: Verify exact installed canary versions and CLI\n', '      - name: Verify exact installed canary versions and CLI\n        continue-on-error: true\n'), text => assertGates(text, 'verify-canary')],
  ['masked verifier failure', text => text.replace('release.json"\n', 'release.json" || true\n'), text => assertGates(text, 'smoke-test')],
  ['skipped Studio check', text => text.replace(`Verify installed Studio without model calls or accounts\n        if: ${gateCondition}`, 'Verify installed Studio without model calls or accounts\n        if: false'), text => assertGates(text, 'smoke-test')],
  ['unversioned installed check', text => text.replace('--version "$EXPECTED_VERSION" ', ''), text => assertGates(text, 'smoke-test')],
  ['unpinned canary checkout', text => text.replace('ref: ${{ github.sha }}', 'ref: master'), text => assertGates(text, 'verify-canary')],
  ['registry fallback for local package', text => text.replace('"$CORE_TGZ" "$STUDIO_TGZ" "$CLI_TGZ"', '"$CORE_TGZ" "$STUDIO_TGZ" "@actalk/inkos@latest"'), text => assertLocalInstall(text, 'smoke-test')],
]) {
  test(`static contract rejects ${label}`, () => {
    const changed = mutate(release);
    assert.notEqual(changed, release);
    assert.throws(() => check(changed));
  });
}

for (const [label, versions, expectedStatus] of [
  ['matching versions', ['2.0.0', '2.0.0', '2.0.0'], 0],
  ['mismatched versions', ['2.0.0', '2.0.1', '2.0.0'], 1],
]) {
  test(`inline version derivation handles ${label}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'inkos-workflow-version-'));
    try {
      ['core', 'studio', 'cli'].forEach((pkg, i) => {
        mkdirSync(join(root, 'packages', pkg), { recursive: true });
        writeFileSync(join(root, 'packages', pkg, 'package.json'), JSON.stringify({ version: versions[i] }));
      });
      const install = run(steps(job(ci, 'installed-package-smoke')).find(step => field(step, 'id', 8) === 'installed-package'));
      const code = install.match(/<<'NODE'\n([\s\S]+?)\nNODE\n/)[1];
      const result = spawnSync(process.execPath, ['--input-type=module'], { cwd: root, input: code, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, result.stderr);
      if (expectedStatus === 0) assert.equal(result.stdout, '2.0.0\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
