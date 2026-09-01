import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSubagentChild, withLock } from "../src/lock.js";

test("isSubagentChild detects subagent environment variables", () => {
  delete process.env.PI_SUBAGENT_DEPTH;
  delete process.env.OMP_SUBAGENT_DEPTH;
  delete process.env.OMP_IS_SUBAGENT;
  assert.equal(isSubagentChild(), false);

  process.env.OMP_SUBAGENT_DEPTH = "1";
  assert.equal(isSubagentChild(), true);

  delete process.env.OMP_SUBAGENT_DEPTH;
  process.env.OMP_IS_SUBAGENT = "true";
  assert.equal(isSubagentChild(), true);

  delete process.env.OMP_IS_SUBAGENT;
});

test("withLock handles process locking and cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lock-test-"));
  const deps = { dir: root };

  const result1 = await withLock(undefined, async () => "executed-1", deps);
  assert.equal(result1, "executed-1");

  const lockFile = path.join(root, ".git-sync", "lock");
  await assert.rejects(async () => fs.stat(lockFile));
});

test("withLock serializes concurrent in-process calls without self-deadlock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lock-concurrent-"));
  const deps = { dir: root };
  const order: number[] = [];

  const task1 = withLock(
    undefined,
    async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return "res1";
    },
    deps
  );

  const task2 = withLock(
    undefined,
    async () => {
      order.push(2);
      return "res2";
    },
    deps
  );

  const [res1, res2] = await Promise.all([task1, task2]);
  assert.equal(res1, "res1");
  assert.equal(res2, "res2");
  assert.deepEqual(order, [1, 2]);
});

