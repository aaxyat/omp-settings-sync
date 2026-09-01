import fs from "node:fs/promises";
import path from "node:path";
import type { GitSyncConfig } from "./config.js";
import { isValidExtraPath } from "./config.js";
import { git } from "./git.js";

export const START_MARKER = "# >>> omp-config-sync managed — do not edit inside this block";
export const END_MARKER = "# <<< omp-config-sync managed";
export const LEGACY_MARKERS: Array<[string, string]> = [
  ["# >>> pi-config-sync managed — do not edit inside this block", "# <<< pi-config-sync managed"],
  ["# >>> pi-git-sync managed — do not edit inside this block", "# <<< pi-git-sync managed"],
];

export const DEFAULT_ALLOWED_PATHS = [
  ".gitignore",
  ".gitattributes",
  "config.yml",
  "config.yaml",
  "mcp.json",
  "settings.json",
  "AGENTS.md",
  "Agents.md",
  "omp-sync.jsonc",
  "omp-sync.json",
  "git-sync.jsonc",
  "git-sync.json",
  "vault.enc",
  ".vault.enc",
  "extensions",
  "skills",
  "agents",
  "chains",
  "prompts",
  "themes",
  "plugins",
];

export const HARD_DENY_PATTERNS = [
  "auth*",
  "*token*",
  "*secret*",
  "*credential*",
  "*key*",
  "*.env",
  "*.env.*",
  "*.local.json",
  "*.local.yml",
  "*.local.yaml",
  "*.db",
  "*.db*",
  "*.db-*",
  "*.sqlite",
  "*.sqlite3",
  "sessions/",
  "state/",
  "blobs/",
  "terminal-sessions/",
  "cache/",
  "natives/",
  "logs/",
  "run/",
  "wt/",
  ".git-sync/",
  "last-changelog-version",
  "**/node_modules/",
  ".DS_Store",
];

export function isDenied(file: string): boolean {
  const normalized = file.toLowerCase().replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "";

  // The encrypted vault is explicitly safe and permitted to sync
  if (basename === "vault.enc" || basename === ".vault.enc") {
    return false;
  }

  const deniedSegments = [
    "sessions",
    "state",
    "blobs",
    "terminal-sessions",
    "cache",
    "natives",
    "logs",
    "run",
    "wt",
    ".git-sync",
    "node_modules",
    "npm",
    "git",
    "bin",
  ];

  if (parts.some((p) => deniedSegments.includes(p))) return true;

  if (
    basename.startsWith("auth") ||
    basename.includes("token") ||
    basename.includes("secret") ||
    basename.includes("credential") ||
    basename.includes("key") ||
    basename === ".env" ||
    basename.includes(".env.") ||
    basename.endsWith(".env") ||
    basename.endsWith(".local.json") ||
    basename.endsWith(".local.yml") ||
    basename.endsWith(".local.yaml") ||
    basename === "last-changelog-version" ||
    basename.endsWith(".db") ||
    basename.includes(".db-") ||
    basename.includes(".db.") ||
    basename.endsWith(".sqlite") ||
    basename.endsWith(".sqlite3")
  ) {
    return true;
  }

  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allowRules(entry: string): string[] {
  const segments = entry.replace(/\/+$/, "").split("/").filter(Boolean);
  const rules: string[] = [];
  let prefix = "";
  for (let i = 0; i < segments.length; i++) {
    prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!;
    if (i < segments.length - 1) {
      rules.push(`!${prefix}/`);
    } else {
      rules.push(`!${prefix}`, `!${prefix}/`, `!${prefix}/**`);
    }
  }
  return rules;
}

export async function ensureIgnoreRules(dir: string, config: GitSyncConfig = {}): Promise<void> {
  const file = path.join(dir, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {}

  const paths = [...DEFAULT_ALLOWED_PATHS, ...(config.extraPaths ?? []).filter(isValidExtraPath)];
  const lines = [
    START_MARKER,
    "*",
    ...paths.flatMap(allowRules),
    "# hard denylist — re-ignored even inside allowed directories",
    ...HARD_DENY_PATTERNS,
    END_MARKER,
  ];
  const block = lines.join("\n");

  let base = existing;
  for (const [start, end] of [[START_MARKER, END_MARKER] as [string, string], ...LEGACY_MARKERS]) {
    const re = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
    base = base.replace(re, "");
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, (base.trim() ? `${base.trim()}\n\n` : "") + block + "\n");
}

export async function ensureInfoExclude(dir: string): Promise<void> {
  const file = path.join(dir, ".git", "info", "exclude");
  await fs.mkdir(path.dirname(file), { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {}

  const existingRules = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = HARD_DENY_PATTERNS.filter((rule) => !existingRules.has(rule));

  if (missing.length) {
    const nextContent = (current.trim() ? `${current.trim()}\n` : "") + missing.join("\n") + "\n";
    await fs.writeFile(file, nextContent);
  }
}

export async function stagedSecretFiles(dir: string): Promise<string[]> {
  const { stdout } = await git(["diff", "--cached", "--name-only", "-z"], dir);
  return stdout.split("\0").filter(Boolean).filter(isDenied);
}

export async function trackedSecretFiles(dir: string): Promise<string[]> {
  try {
    const { stdout } = await git(["ls-files", "-z"], dir);
    return stdout.split("\0").filter(Boolean).filter(isDenied);
  } catch {
    return [];
  }
}
