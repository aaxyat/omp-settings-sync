import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.js";
import {
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  isSubagentChild,
  resolveAutoSyncIntervalMs,
  shouldAutoSync,
  withLock,
  writeSyncState,
} from "../src/lock.js";

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


test("resolveAutoSyncIntervalMs defaults to 60 s, honors the config and clamps to a 1 minute minimum", () => {
  assert.equal(DEFAULT_AUTO_SYNC_INTERVAL_MINUTES, 1);
  assert.equal(resolveAutoSyncIntervalMs(undefined), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(null), 60_000);
  assert.equal(resolveAutoSyncIntervalMs("5"), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(Number.NaN), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(1), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(0), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(-3), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(0.1), 60_000);
  assert.equal(resolveAutoSyncIntervalMs(5), 300_000);
  assert.equal(resolveAutoSyncIntervalMs(60), 3_600_000);
});

test("shouldAutoSync gates on lastAutoSyncAt and the configured autoSyncIntervalMinutes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autosync-test-"));
  await git(["init", "-b", "main"], root);
  await git(["remote", "add", "origin", "https://example.invalid/repo.git"], root);
  const deps = { dir: root };

  // Never synced -> allowed
  assert.equal(await shouldAutoSync(deps), true);

  // Default interval (1 minute): synced 10 s ago -> blocked, 2 minutes ago -> allowed
  await writeSyncState({ lastAutoSyncAt: new Date(Date.now() - 10_000).toISOString() }, root);
  assert.equal(await shouldAutoSync(deps), false);
  await writeSyncState({ lastAutoSyncAt: new Date(Date.now() - 120_000).toISOString() }, root);
  assert.equal(await shouldAutoSync(deps), true);

  // Configured 30 minutes: synced 10 minutes ago -> blocked, 31 minutes ago -> allowed
  await fs.writeFile(path.join(root, "omp-sync.jsonc"), '{ "autoSyncIntervalMinutes": 30 }');
  await writeSyncState({ lastAutoSyncAt: new Date(Date.now() - 10 * 60_000).toISOString() }, root);
  assert.equal(await shouldAutoSync(deps), false);
  await writeSyncState({ lastAutoSyncAt: new Date(Date.now() - 31 * 60_000).toISOString() }, root);
  assert.equal(await shouldAutoSync(deps), true);

  // The timer fires at exactly the interval; the stamp is written slightly earlier in the previous tick.
  await writeSyncState({ lastAutoSyncAt: new Date(Date.now() - 30 * 60_000 + 500).toISOString() }, root);
  assert.equal(await shouldAutoSync(deps), true);
});
