import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFileCb);

async function sh(cmd, args, cwd) {
  return exec(cmd, args, { cwd });
}

console.log("==================================================");
console.log("🚀 Starting Oh My Pi Config Sync Docker End-to-End Test");
console.log("==================================================");

const VAULT_PASSPHRASE = "MyDockerTestPassphrase2026!";

// Import the latest built modules from /workspace/dist
const {
  runInit,
  runLink,
  runSync,
  runUnlockVault,
  showStatus,
} = await import("/workspace/dist/sync.js");
const { getVaultStatus, hasVaultFile } = await import("/workspace/dist/vault.js");
const { stagedSecretFiles, trackedSecretFiles, isDenied } = await import(
  "/workspace/dist/security.js"
);

// Setup Machine 1 directory
const machine1Dir = "/tmp/machine1/agent";
await fs.mkdir(path.join(machine1Dir, "extensions"), { recursive: true });
await fs.mkdir(path.join(machine1Dir, "skills"), { recursive: true });
await fs.mkdir(path.join(machine1Dir, "agents"), { recursive: true });

await fs.writeFile(
  path.join(machine1Dir, "config.yml"),
  "theme:\n  dark: titanium\nsetupVersion: 2\nshellPath: /bin/bash\n"
);
await fs.writeFile(
  path.join(machine1Dir, "mcp.json"),
  JSON.stringify({ mcpServers: { context7: { enabled: true } } }, null, 2)
);
await fs.writeFile(path.join(machine1Dir, "AGENTS.md"), "# Master Agent Directives\n- Test Rule from Machine 1\n");
await fs.writeFile(
  path.join(machine1Dir, "extensions", "my-test-extension.ts"),
  'import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";\nexport default function(pi: ExtensionAPI) { pi.setLabel("Docker Test Extension"); }\n'
);
await fs.writeFile(
  path.join(machine1Dir, "auth.json"),
  JSON.stringify({ anthropic_key: "sk-ant-docker-test-secret-98765", session_token: "session_jwt_token_abc" })
);

console.log("\n💻 Step 1: Machine 1 - Initializing /ompsync init with encrypted vault...");
console.log("   Target repository: OhMyPiSyncData (private)");

// Execute runInit with vault password
let machine1Notified = [];
await runInit(
  "",
  undefined,
  {
    dir: machine1Dir,
    notify: (msg, level) => {
      console.log(`   [Machine 1 ${level}] ${msg}`);
      machine1Notified.push(msg);
    },
  },
  { password: VAULT_PASSPHRASE }
);

// Verify Machine 1 state
assert.equal(await getVaultStatus(machine1Dir), "unlocked", "Machine 1 vault should be unlocked");
assert.equal(await hasVaultFile(machine1Dir), true, "Machine 1 should have vault.enc");

// Verify security: auth.json is NOT tracked in git
const { stdout: trackedFiles } = await sh("git", ["ls-files"], machine1Dir);
console.log("\n🛡️ Step 2: Verifying Git tracking security on Machine 1...");
console.log("   Tracked files in git:\n   " + trackedFiles.trim().split("\n").join("\n   "));

assert.ok(trackedFiles.includes("config.yml"), "config.yml must be tracked");
assert.ok(trackedFiles.includes("mcp.json"), "mcp.json must be tracked");
assert.ok(trackedFiles.includes("AGENTS.md"), "AGENTS.md must be tracked");
assert.ok(trackedFiles.includes("extensions/my-test-extension.ts"), "extension must be tracked");
assert.ok(trackedFiles.includes("vault.enc"), "vault.enc must be tracked");
assert.ok(!trackedFiles.includes("auth.json"), "CRITICAL: auth.json must NOT be tracked in git!");
assert.deepEqual(await trackedSecretFiles(machine1Dir), [], "No secret files should be tracked");
console.log("   ✅ Security invariant passed: auth.json is NOT tracked in plaintext!");

// ==========================================
// Machine 2: New Device Linking with Password
// ==========================================
console.log("\n💻 Step 3: Machine 2 - Simulating new device onboarding with password...");
const machine2Dir = "/tmp/machine2/agent";
await fs.mkdir(machine2Dir, { recursive: true });
await fs.writeFile(path.join(machine2Dir, "auth.json"), "original-local-machine2-key");

let machine2Notified = [];
await runLink(
  "",
  undefined,
  {
    dir: machine2Dir,
    notify: (msg, level) => {
      console.log(`   [Machine 2 ${level}] ${msg}`);
      machine2Notified.push(msg);
    },
  },
  { password: VAULT_PASSPHRASE }
);

// Verify Machine 2 state and restored files
console.log("\n🔍 Step 4: Verifying restored files on Machine 2...");
assert.equal(await getVaultStatus(machine2Dir), "unlocked", "Machine 2 vault should be unlocked");

const restoredConfig = await fs.readFile(path.join(machine2Dir, "config.yml"), "utf8");
assert.ok(restoredConfig.includes("titanium"), "config.yml theme should be restored");

const restoredAgents = await fs.readFile(path.join(machine2Dir, "AGENTS.md"), "utf8");
assert.ok(restoredAgents.includes("Test Rule from Machine 1"), "AGENTS.md rules should be restored");

const restoredExt = await fs.readFile(path.join(machine2Dir, "extensions", "my-test-extension.ts"), "utf8");
assert.ok(restoredExt.includes("Docker Test Extension"), "Custom extension should be restored");

const restoredAuth = JSON.parse(await fs.readFile(path.join(machine2Dir, "auth.json"), "utf8"));
assert.equal(restoredAuth.anthropic_key, "sk-ant-docker-test-secret-98765", "auth.json key should be restored");
assert.equal(restoredAuth.session_token, "session_jwt_token_abc", "session_token should be restored");
console.log("   ✅ Machine 2 successfully restored config, extensions, and decrypted auth.json!");

// ==========================================================
// Machine 3: New Device Linking WITHOUT Password (Graceful Fallback)
// ==========================================================
console.log("\n💻 Step 5: Machine 3 - Simulating new device onboarding WITHOUT password...");
const machine3Dir = "/tmp/machine3/agent";
await fs.mkdir(machine3Dir, { recursive: true });
await fs.writeFile(path.join(machine3Dir, "auth.json"), "machine3-untouched-secret");

let machine3Notified = [];
await runLink(
  "",
  undefined,
  {
    dir: machine3Dir,
    notify: (msg, level) => {
      console.log(`   [Machine 3 ${level}] ${msg}`);
      machine3Notified.push(msg);
    },
  },
  { password: "" } // No password provided
);

// Verify Machine 3 state
assert.equal(await getVaultStatus(machine3Dir), "locked", "Machine 3 vault should remain locked");
assert.equal(
  await fs.readFile(path.join(machine3Dir, "auth.json"), "utf8"),
  "machine3-untouched-secret",
  "auth.json should remain untouched when password is not provided"
);
assert.ok(
  (await fs.readFile(path.join(machine3Dir, "AGENTS.md"), "utf8")).includes("Test Rule from Machine 1"),
  "Unencrypted AGENTS.md should be synced"
);
console.log("   ✅ Machine 3 gracefully synced unencrypted config without errors while keeping vault locked!");

// ==========================================================
// Machine 3: Unlock Vault Later
// ==========================================================
console.log("\n🔓 Step 6: Machine 3 - Unlocking credentials vault later via command...");
await runUnlockVault(VAULT_PASSPHRASE, undefined, {
  dir: machine3Dir,
  notify: (msg, level) => {
    console.log(`   [Machine 3 ${level}] ${msg}`);
  },
});

assert.equal(await getVaultStatus(machine3Dir), "unlocked", "Machine 3 vault should now be unlocked");
const machine3RestoredAuth = JSON.parse(await fs.readFile(path.join(machine3Dir, "auth.json"), "utf8"));
assert.equal(machine3RestoredAuth.anthropic_key, "sk-ant-docker-test-secret-98765");
console.log("   ✅ Machine 3 successfully unlocked vault and restored auth.json!");

console.log("\n==================================================");
console.log("🎉 ALL DOCKER END-TO-END TESTS PASSED SUCCESSFULLY!");
console.log("==================================================");
