import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkAndBackgroundSync, runInit, runLink, runSync, runUnlockVault, showStatus } from "../src/sync.js";
import { getVaultStatus } from "../src/vault.js";
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

test("checkAndBackgroundSync detects local changes and syncs them automatically", async () => {
  const a = await createMachineFixture("bg-sync-a");
  const remote = await createBareRemote(a.root);
  const ghA = createFakeGh();

  await runInit(remote, undefined, { dir: a.dir, gh: ghA });

  // No changes -> returns false
  const syncedWithoutChanges = await checkAndBackgroundSync(undefined, { dir: a.dir });
  assert.equal(syncedWithoutChanges, false);

  // Add change -> returns true and commits/pushes
  await fs.writeFile(path.join(a.dir, "AGENTS.md"), "# Background synced changes\n");
  const syncedWithChanges = await checkAndBackgroundSync(undefined, { dir: a.dir });
  assert.equal(syncedWithChanges, true);

  // Link on Machine B and verify change was synced
  const b = await createMachineFixture("bg-sync-b");
  const ghB = createFakeGh();
  await runLink(remote, undefined, { dir: b.dir, gh: ghB });
  assert.equal(await fs.readFile(path.join(b.dir, "AGENTS.md"), "utf8"), "# Background synced changes\n");
});

test("encrypted vault lifecycle: init with password, link with password restores auth.json, link without password gracefully falls back and unlocks later", async () => {
  const a = await createMachineFixture("vault-a");
  await fs.writeFile(path.join(a.dir, "auth.json"), JSON.stringify({ token: "synced-token-123" }));
  const remote = await createBareRemote(a.root);
  const ghA = createFakeGh();

  const vaultPassphrase = "MySecretVaultPassword456!";

  // 1. Init on Machine A with encrypted vault
  await runInit(remote, undefined, { dir: a.dir, gh: ghA }, { password: vaultPassphrase });
  assert.equal(await getVaultStatus(a.dir), "unlocked");

  // 2. Link on Machine B WITH password -> auth.json is restored
  const b = await createMachineFixture("vault-b");
  const ghB = createFakeGh();
  await runLink(remote, undefined, { dir: b.dir, gh: ghB }, { password: vaultPassphrase });

  assert.equal(await getVaultStatus(b.dir), "unlocked");
  const authB = JSON.parse(await fs.readFile(path.join(b.dir, "auth.json"), "utf8")) as { token: string };
  assert.equal(authB.token, "synced-token-123");

  // 3. Link on Machine C WITHOUT password -> gracefully syncs unencrypted config, vault stays locked
  const c = await createMachineFixture("vault-c");
  await fs.writeFile(path.join(c.dir, "auth.json"), "original-c-secret");
  const ghC = createFakeGh();

  let linkWarning = "";
  await runLink(
    remote,
    undefined,
    {
      dir: c.dir,
      gh: ghC,
      notify: (msg) => {
        linkWarning += msg;
      },
    },
    { password: "" } // empty/skipped password
  );

  // Does NOT error!
  assert.equal(await getVaultStatus(c.dir), "locked");
  // Original local auth file untouched
  assert.equal(await fs.readFile(path.join(c.dir, "auth.json"), "utf8"), "original-c-secret");
  // Unencrypted config is synced
  assert.equal(await fs.readFile(path.join(c.dir, "AGENTS.md"), "utf8"), "# Agent Instructions\n");

  // 4. Unlock vault later on Machine C through command
  await runUnlockVault(vaultPassphrase, undefined, { dir: c.dir });
  assert.equal(await getVaultStatus(c.dir), "unlocked");
  const authC = JSON.parse(await fs.readFile(path.join(c.dir, "auth.json"), "utf8")) as { token: string };
  assert.equal(authC.token, "synced-token-123");
});
