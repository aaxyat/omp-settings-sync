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
  assert.equal(
    (await fs.readFile(path.join(a.dir, "AGENTS.md"), "utf8")).replace(/\r\n/g, "\n"),
    "# Updated on B\n"
  );
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
  assert.equal(
    (await fs.readFile(path.join(b.dir, "AGENTS.md"), "utf8")).replace(/\r\n/g, "\n"),
    "# Background synced changes\n"
  );
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
  assert.equal(
    (await fs.readFile(path.join(c.dir, "AGENTS.md"), "utf8")).replace(/\r\n/g, "\n"),
    "# Agent Instructions\n"
  );


  // 4. Unlock vault later on Machine C through command
  await runUnlockVault(vaultPassphrase, undefined, { dir: c.dir });
  assert.equal(await getVaultStatus(c.dir), "unlocked");
  const authC = JSON.parse(await fs.readFile(path.join(c.dir, "auth.json"), "utf8")) as { token: string };
  assert.equal(authC.token, "synced-token-123");
});

test("bidirectional credential sync updates auth.json between machines seamlessly without conflicts", async () => {
  const a = await createMachineFixture("sync-cred-a");
  await fs.writeFile(path.join(a.dir, "auth.json"), JSON.stringify({ token: "initial-token-1" }));
  const remote = await createBareRemote(a.root);
  const ghA = createFakeGh();
  const passphrase = "SyncCredentialsSecret123!";

  // 1. Machine A inits with vault
  await runInit(remote, undefined, { dir: a.dir, gh: ghA }, { password: passphrase });

  // 2. Machine B links with vault
  const b = await createMachineFixture("sync-cred-b");
  const ghB = createFakeGh();
  await runLink(remote, undefined, { dir: b.dir, gh: ghB }, { password: passphrase });

  const authB1 = JSON.parse(await fs.readFile(path.join(b.dir, "auth.json"), "utf8")) as { token: string };
  assert.equal(authB1.token, "initial-token-1");

  // 3. Machine A updates token on "homelab" and syncs
  await fs.writeFile(path.join(a.dir, "auth.json"), JSON.stringify({ token: "updated-homelab-token" }));
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });

  // 4. Machine B syncs on "PC" -> receives updated token
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });
  const authB2 = JSON.parse(await fs.readFile(path.join(b.dir, "auth.json"), "utf8")) as { token: string };
  assert.equal(authB2.token, "updated-homelab-token");

  // 5. Machine B updates token on "PC" and syncs back
  await fs.writeFile(path.join(b.dir, "auth.json"), JSON.stringify({ token: "updated-pc-token" }));
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });

  // 6. Machine A syncs on "homelab" -> receives updated token
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });
  const authA2 = JSON.parse(await fs.readFile(path.join(a.dir, "auth.json"), "utf8")) as { token: string };
  assert.equal(authA2.token, "updated-pc-token");
});

test("showStatus outputs rich status with conflict detection and resolution instructions", async () => {
  const a = await createMachineFixture("status-test");
  const remote = await createBareRemote(a.root);
  const ghA = createFakeGh();
  await runInit(remote, undefined, { dir: a.dir, gh: ghA }, { password: "Pass" });

  let normalStatusMsg = "";
  await showStatus(undefined, {
    dir: a.dir,
    notify: (msg) => {
      normalStatusMsg += msg;
    },
  });

  assert.match(normalStatusMsg, /📁 Repository:/);
  assert.match(normalStatusMsg, /🌿 Branch:/);
  assert.match(normalStatusMsg, /🌐 Remote Sync: up to date/);
  assert.match(normalStatusMsg, /🔐 Vault Status: unlocked/);

  // Simulate active merge state
  await fs.writeFile(path.join(a.dir, ".git", "MERGE_HEAD"), "dummy_commit\n");

  let conflictStatusMsg = "";
  let conflictLevel = "";
  await showStatus(undefined, {
    dir: a.dir,
    notify: (msg, level) => {
      conflictStatusMsg += msg;
      conflictLevel = level;
    },
  });

  assert.equal(conflictLevel, "warning");
  assert.match(conflictStatusMsg, /⚠️ GIT CONFLICT \/ REBASE DETECTED/);
  assert.match(conflictStatusMsg, /👉 How to resolve:/);
  assert.match(conflictStatusMsg, /git checkout --theirs/);

  // Clean up
  await fs.rm(path.join(a.dir, ".git", "MERGE_HEAD"), { force: true });
});

test("runInit allows fresh re-initialization when remote repo is deleted or --force is specified", async () => {
  const a = await createMachineFixture("recovery-test");
  const remote1 = await createBareRemote(a.root, "remote1.git");
  const ghA = createFakeGh();

  // 1. Initial setup
  await runInit(remote1, undefined, { dir: a.dir, gh: ghA });

  // 2. Simulate remote repo deleted/gone
  await fs.rm(remote1, { recursive: true, force: true });

  // 3. runInit with a new remote or --force succeeds without throwing 'already initialized'
  const remote2 = await createBareRemote(a.root, "remote2.git");
  await runInit(remote2, undefined, { dir: a.dir, gh: ghA });

  // Verify it can sync to the new remote
  await fs.writeFile(path.join(a.dir, "AGENTS.md"), "# Recovery Successful\n");
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });
});


