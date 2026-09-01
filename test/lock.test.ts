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
