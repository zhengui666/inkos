import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./restore-package-json.mjs", import.meta.url));
const original = Buffer.from('\uFEFF{\r\n  "name": "恢复测试",\r\n  "version": "1.0.0"\r\n}\r\n');
const prepared = Buffer.from('{"name":"prepared"}\n');

async function fixture(t) {
  const packageDir = await mkdtemp(join(tmpdir(), "inkos-restore-package-json-"));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  return {
    packageDir,
    packageJsonPath: join(packageDir, "package.json"),
    backupPath: join(packageDir, ".package.json.publish-backup"),
  };
}

function run(packageDir) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: packageDir,
    encoding: "utf-8",
    env: {},
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function assertFailure(result) {
  assert.notEqual(result.status, 0, result.stderr || "script unexpectedly exited successfully");
  assert.notEqual(result.stderr, "", "failure should report an error");
  assert.equal(result.stdout, "", "failure must not print success");
  assert.doesNotMatch(result.stderr, /success|restored|恢复成功/i);
}

test("no backup exits zero and leaves package.json unchanged", async (t) => {
  const { packageDir, packageJsonPath } = await fixture(t);
  await writeFile(packageJsonPath, prepared);

  const result = run(packageDir);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(packageJsonPath), prepared);
});

test("restores the exact backup bytes and removes the backup", async (t) => {
  const { packageDir, packageJsonPath, backupPath } = await fixture(t);
  await writeFile(packageJsonPath, prepared);
  await writeFile(backupPath, original);

  const result = run(packageDir);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(packageJsonPath), original);
  await assert.rejects(stat(backupPath), { code: "ENOENT" });
});

test("rename failure exits nonzero and preserves the backup", async (t) => {
  const { packageDir, packageJsonPath, backupPath } = await fixture(t);
  await mkdir(packageJsonPath);
  await writeFile(backupPath, original);

  const result = run(packageDir);

  assertFailure(result);
  assert.deepEqual(await readFile(backupPath), original);
  assert.equal((await stat(packageJsonPath)).isDirectory(), true);
});

test("a backup directory causes a nonzero read failure", async (t) => {
  const { packageDir, packageJsonPath, backupPath } = await fixture(t);
  await writeFile(packageJsonPath, prepared);
  await mkdir(backupPath);

  const result = run(packageDir);

  assertFailure(result);
  assert.deepEqual(await readFile(packageJsonPath), prepared);
  assert.equal((await stat(backupPath)).isDirectory(), true);
});
