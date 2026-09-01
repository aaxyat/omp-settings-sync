import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GhClient {
  available(): Promise<boolean>;
  currentUser(): Promise<string>;
  repoExists(id: string): Promise<boolean>;
  isPrivate(id: string): Promise<boolean | undefined>;
  createPrivateRepo(id: string): Promise<void>;
  remoteUrl(id: string): string;
}

export const LIKELY_SYNC_REPO_NAMES = [
  "omp-agent-config",
  "my-omp-config",
  "omp-config",
  "dotfiles-omp",
  "pi-agent-config",
];

export function parseRepoReference(input: string, fallbackOwner: string): { owner: string; name: string } | undefined {
  const raw = input.trim().replace(/\.git$/i, "");
  if (!raw) return undefined;

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };

  try {
    const url = new URL(raw);
    if (["github.com", "www.github.com"].includes(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 2) {
        return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/i, "") };
      }
    }
  } catch {}

  const bits = raw.split("/").filter(Boolean);
  if (bits.length === 1) return { owner: fallbackOwner, name: bits[0]! };
  if (bits.length === 2 && !raw.includes(":")) return { owner: bits[0]!, name: bits[1]! };

  return undefined;
}

export function remoteFromArg(arg: string, fallbackOwner: string): string | undefined {
  if (/^(https?|ssh):\/\//.test(arg) || /^git@/.test(arg) || arg.startsWith("/") || arg.startsWith(".")) {
    return arg;
  }
  const ref = parseRepoReference(arg, fallbackOwner);
  return ref ? `https://github.com/${ref.owner}/${ref.name}.git` : undefined;
}

export const defaultGh: GhClient = {
  async available() {
    try {
      await exec("gh", ["auth", "status"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },
  async currentUser() {
    return (await exec("gh", ["api", "user", "--jq", ".login"])).stdout.trim();
  },
  async repoExists(id: string) {
    try {
      await exec("gh", ["repo", "view", id, "--json", "name"]);
      return true;
    } catch {
      return false;
    }
  },
  async isPrivate(id: string) {
    try {
      const { stdout } = await exec("gh", ["repo", "view", id, "--json", "isPrivate"]);
      const parsed: unknown = JSON.parse(stdout);
      if (parsed && typeof parsed === "object" && "isPrivate" in parsed && typeof parsed.isPrivate === "boolean") {
        return parsed.isPrivate;
      }
      return undefined;
    } catch {
      return undefined;
    }
  },
  async createPrivateRepo(id: string) {
    await exec("gh", ["repo", "create", id, "--private"], { timeout: 15_000 });
  },
  remoteUrl(id: string) {
    return `https://github.com/${id}.git`;
  },
};
