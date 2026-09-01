import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cacheVaultPassword,
  clearCachedVaultPassword,
  decryptPayload,
  encryptPayload,
  getCachedVaultPassword,
  getVaultStatus,
  hasVaultFile,
  packSensitiveFiles,
  unpackSensitiveFiles,
  writeVaultFile,
  type VaultPayload,
} from "../src/vault.js";

test("encryptPayload and decryptPayload round-trip securely with AES-256-GCM", () => {
  const payload: VaultPayload = {
    updatedAt: new Date().toISOString(),
    files: {
      "auth.json": JSON.stringify({ token: "sk-test-12345", provider: "anthropic" }),
      "auth-broker.json": JSON.stringify({ secret: "broker-secret-abc" }),
    },
  };

  const password = "SuperSecretPassword123!";
  const encrypted = encryptPayload(payload, password);

  assert.doesNotMatch(encrypted, /sk-test-12345/);
  assert.doesNotMatch(encrypted, /broker-secret-abc/);
  assert.match(encrypted, /"kdf":\s*"scrypt"/);
  assert.match(encrypted, /"tag":/);

  const decrypted = decryptPayload(encrypted, password);
  assert.deepEqual(decrypted, payload);
});

test("decryptPayload fails with incorrect password or tampered ciphertext", () => {
  const payload: VaultPayload = {
    updatedAt: new Date().toISOString(),
    files: { "auth.json": "my-secret-key" },
  };

  const encrypted = encryptPayload(payload, "correct-password");

  // Wrong password
  assert.throws(
    () => decryptPayload(encrypted, "wrong-password"),
    /Decryption failed: incorrect passphrase/
  );

  // Tampered ciphertext
  const parsed = JSON.parse(encrypted) as { ciphertext: string };
  const tamperedCiphertext = Buffer.from(parsed.ciphertext, "base64");
  tamperedCiphertext[0] = (tamperedCiphertext[0]! ^ 0xff);
  parsed.ciphertext = tamperedCiphertext.toString("base64");

  assert.throws(
    () => decryptPayload(JSON.stringify(parsed), "correct-password"),
    /Decryption failed: incorrect passphrase or corrupted data/
  );
});

test("packSensitiveFiles, writeVaultFile, and unpackSensitiveFiles restore credentials", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vault-test-"));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ apiKey: "test-key" }));

  const payload = await packSensitiveFiles(dir);
  assert.ok(payload.files["auth.json"]);

  const password = "my-vault-pass";
  const encrypted = encryptPayload(payload, password);
  await writeVaultFile(dir, encrypted);
  assert.equal(await hasVaultFile(dir), true);

  // Delete local auth.json
  await fs.rm(path.join(dir, "auth.json"));

  // Decrypt and unpack
  const readBack = decryptPayload(encrypted, password);
  const unpacked = await unpackSensitiveFiles(dir, readBack);
  assert.deepEqual(unpacked, ["auth.json"]);

  const restored = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8")) as { apiKey: string };
  assert.equal(restored.apiKey, "test-key");
});

test("cacheVaultPassword and clearCachedVaultPassword control vault status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vault-status-test-"));
  assert.equal(await getVaultStatus(dir), "disabled");

  const encrypted = encryptPayload({ updatedAt: new Date().toISOString(), files: {} }, "pass123");
  await writeVaultFile(dir, encrypted);

  // Without cached password, vault is locked
  assert.equal(await getVaultStatus(dir), "locked");

  // Cache password -> unlocked
  await cacheVaultPassword(dir, "pass123");
  assert.equal(await getCachedVaultPassword(dir), "pass123");
  assert.equal(await getVaultStatus(dir), "unlocked");

  // Clear cached password -> locked again
  await clearCachedVaultPassword(dir);
  assert.equal(await getCachedVaultPassword(dir), undefined);
  assert.equal(await getVaultStatus(dir), "locked");
});

test("hashSensitiveFiles and hasSensitiveChanges detect actual credential modifications", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vault-hash-test-"));
  const { hashSensitiveFiles, hasSensitiveChanges, saveSensitiveHash, getSavedSensitiveHash } = await import(
    "../src/vault.js"
  );

  // Initially empty -> no changes
  assert.equal(await hasSensitiveChanges(dir), false);

  // Write auth.json
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "token-1" }));
  assert.equal(await hasSensitiveChanges(dir), true);

  const hash1 = await hashSensitiveFiles(dir);
  assert.ok(hash1.length > 0);
  await saveSensitiveHash(dir, hash1);
  assert.equal(await getSavedSensitiveHash(dir), hash1);
  assert.equal(await hasSensitiveChanges(dir), false);

  // Modify auth.json -> changes detected
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "token-2" }));
  assert.equal(await hasSensitiveChanges(dir), true);

  const hash2 = await hashSensitiveFiles(dir);
  assert.notEqual(hash1, hash2);
});

