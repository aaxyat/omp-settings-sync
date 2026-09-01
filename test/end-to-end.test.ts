import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runInit, runLink, runSync } from "../src/sync.js";
import { createBareRemote, createFakeGh, createMachineFixture } from "./helpers.js";

test("end-to-end round trip: init machine A, link machine B, sync bidirectional changes", async () => {
  const a = await createMachineFixture("machine-a");
  const remote = await createBareRemote(a.root);
  const ghA = createFakeGh();

  // 1. Init on Machine A
  await runInit(remote, undefined, { dir: a.dir, gh: ghA });

  // 2. Link on Machine B
  const b = await createMachineFixture("machine-b");
  await fs.writeFile(path.join(b.dir, "config.yml"), "theme:\n  dark: custom-b\n");
  const ghB = createFakeGh();
  await runLink(remote, undefined, { dir: b.dir, gh: ghB });

  // Local differing file moved to .local-backup
  assert.ok(await fs.stat(path.join(b.dir, "config.yml.local-backup")));
  assert.equal(await fs.readFile(path.join(b.dir, "auth.json"), "utf8"), "secret-key-machine-b");

  // 3. Make change on Machine B and sync
  await fs.writeFile(path.join(b.dir, "AGENTS.md"), "# Updated on B\n");
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });

  // 4. Sync Machine A and verify change received
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });
  assert.equal(await fs.readFile(path.join(a.dir, "AGENTS.md"), "utf8"), "# Updated on B\n");
});
