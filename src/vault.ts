import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface EncryptedVaultFile {
  version: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface VaultPayload {
  updatedAt: string;
  files: Record<string, string>;
}

const VAULT_FILENAME = "vault.enc";
let inMemoryPasswordCache: Map<string, string> = new Map();

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptPayload(payload: VaultPayload, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const vaultFile: EncryptedVaultFile = {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  return JSON.stringify(vaultFile, null, 2) + "\n";
}

export function decryptPayload(encryptedJson: string, password: string): VaultPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encryptedJson);
  } catch {
    throw new Error("Corrupt vault file: invalid JSON format");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("ciphertext" in parsed) ||
    !("salt" in parsed) ||
    !("iv" in parsed) ||
    !("tag" in parsed) ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string"
  ) {
    throw new Error("Corrupt vault file: missing cryptographic headers");
  }

  const salt = Buffer.from(parsed.salt, "base64");
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64");

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Decryption failed: incorrect passphrase or corrupted data");
  }

  const payload: unknown = JSON.parse(decrypted.toString("utf8"));
  if (
    !payload ||
    typeof payload !== "object" ||
    !("files" in payload) ||
    typeof payload.files !== "object" ||
    payload.files === null
  ) {
    throw new Error("Corrupted vault payload: invalid format");
  }

  return payload as VaultPayload;
}

export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  mode?: number
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, content, { encoding: typeof content === "string" ? "utf8" : undefined, mode });
  try {
    await fs.rename(tmpPath, targetPath);
  } catch {
    await fs.rm(targetPath, { force: true });
    await fs.rename(tmpPath, targetPath);
  }
}

export function vaultPath(dir: string): string {
  return path.join(dir, VAULT_FILENAME);
}

export async function hasVaultFile(dir: string): Promise<boolean> {
  for (const name of [VAULT_FILENAME, ".vault.enc"]) {
    try {
      await fs.access(path.join(dir, name));
      return true;
    } catch {}
  }
  return false;
}

export async function readVaultFile(dir: string): Promise<string | undefined> {
  for (const name of [VAULT_FILENAME, ".vault.enc"]) {
    try {
      return await fs.readFile(path.join(dir, name), "utf8");
    } catch {}
  }
  return undefined;
}

export async function writeVaultFile(dir: string, content: string): Promise<void> {
  await atomicWriteFile(vaultPath(dir), content);
}

export async function deleteVaultFile(dir: string): Promise<void> {
  for (const name of [VAULT_FILENAME, ".vault.enc"]) {
    try {
      await fs.rm(path.join(dir, name), { force: true });
    } catch {}
  }
}

export async function cacheVaultPassword(dir: string, password: string): Promise<void> {
  inMemoryPasswordCache.set(dir, password);
  const stateDir = path.join(dir, ".git-sync");
  // Store password locally in non-tracked .git-sync/vault.key
  await atomicWriteFile(path.join(stateDir, "vault.key"), password, 0o600);
}

export async function getCachedVaultPassword(dir: string): Promise<string | undefined> {
  if (inMemoryPasswordCache.has(dir)) {
    return inMemoryPasswordCache.get(dir);
  }
  try {
    const key = await fs.readFile(path.join(dir, ".git-sync", "vault.key"), "utf8");
    if (key.trim()) {
      inMemoryPasswordCache.set(dir, key.trim());
      return key.trim();
    }
  } catch {}
  return undefined;
}

export async function clearCachedVaultPassword(dir: string): Promise<void> {
  inMemoryPasswordCache.delete(dir);
  try {
    await fs.rm(path.join(dir, ".git-sync", "vault.key"), { force: true });
  } catch {}
}

export const SYNCABLE_SENSITIVE_FILES = ["auth.json", "auth-broker.json"];

export async function hashSensitiveFiles(dir: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  let foundAny = false;

  for (const rel of [...SYNCABLE_SENSITIVE_FILES].sort()) {
    try {
      const content = await fs.readFile(path.join(dir, rel));
      hash.update(`${rel}:`);
      hash.update(content);
      foundAny = true;
    } catch {}
  }

  return foundAny ? hash.digest("hex") : "";
}

export async function getSavedSensitiveHash(dir: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(dir, ".git-sync", "sensitive.hash"), "utf8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function saveSensitiveHash(dir: string, hash: string): Promise<void> {
  const stateDir = path.join(dir, ".git-sync");
  await atomicWriteFile(path.join(stateDir, "sensitive.hash"), hash);
}

export async function hasSensitiveChanges(dir: string): Promise<boolean> {
  const currentHash = await hashSensitiveFiles(dir);
  let savedHash = await getSavedSensitiveHash(dir);

  // If savedHash is missing but a vault file exists, check if vault.enc already contains current files
  if (!savedHash && currentHash && (await hasVaultFile(dir))) {
    const password = await getCachedVaultPassword(dir);
    const vaultRaw = await readVaultFile(dir);
    if (password && vaultRaw) {
      try {
        const payload = decryptPayload(vaultRaw, password);
        const hash = crypto.createHash("sha256");
        let found = false;
        for (const rel of [...SYNCABLE_SENSITIVE_FILES].sort()) {
          if (payload.files[rel] !== undefined) {
            hash.update(`${rel}:`);
            hash.update(payload.files[rel]!);
            found = true;
          }
        }
        const payloadHash = found ? hash.digest("hex") : "";
        if (payloadHash === currentHash) {
          await saveSensitiveHash(dir, currentHash);
          return false;
        }
      } catch {}
    }
  }

  // If no sensitive files exist currently and none were saved, no changes
  if (!currentHash && !savedHash) return false;

  // If saved hash matches current hash, no changes
  return currentHash !== savedHash;
}

export async function packSensitiveFiles(dir: string): Promise<VaultPayload> {
  const files: Record<string, string> = {};

  for (const rel of SYNCABLE_SENSITIVE_FILES) {
    try {
      const content = await fs.readFile(path.join(dir, rel), "utf8");
      files[rel] = content;
    } catch {}
  }

  return {
    updatedAt: new Date().toISOString(),
    files,
  };
}

export async function unpackSensitiveFiles(dir: string, payload: VaultPayload): Promise<string[]> {
  const unpacked: string[] = [];
  for (const [filename, content] of Object.entries(payload.files)) {
    const target = path.join(dir, filename);
    await atomicWriteFile(target, content, 0o600);
    unpacked.push(filename);
  }
  const currentHash = await hashSensitiveFiles(dir);
  if (currentHash) {
    await saveSensitiveHash(dir, currentHash);
  }
  return unpacked;
}


export async function getVaultStatus(dir: string): Promise<"disabled" | "locked" | "unlocked"> {
  const exists = await hasVaultFile(dir);
  if (!exists) return "disabled";

  const cached = await getCachedVaultPassword(dir);
  if (!cached) return "locked";

  const vaultRaw = await readVaultFile(dir);
  if (!vaultRaw) return "disabled";

  try {
    decryptPayload(vaultRaw, cached);
    return "unlocked";
  } catch {
    return "locked";
  }
}

