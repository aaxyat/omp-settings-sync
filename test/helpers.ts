import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GhClient } from "../src/gh.js";

process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "omp-settings-sync tests";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "tests@omp-settings-sync.invalid";
delete process.env.PI_SUBAGENT_DEPTH;
delete process.env.OMP_SUBAGENT_DEPTH;
delete process.env.OMP_IS_SUBAGENT;

const exec = promisify(execFileCb);

export async function sh(cmd: string, args: string[], cwd?: string) {
  return exec(cmd, args, { cwd });
}

export interface MachineFixture {
  root: string;
  dir: string;
}

export async function createMachineFixture(name: string): Promise<MachineFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-sync-test-${name}-`));
  const dir = path.join(root, "agent");
  await fs.mkdir(path.join(dir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  await fs.mkdir(path.join(dir, "agents"), { recursive: true });
  await fs.writeFile(path.join(dir, "config.yml"), `theme:\n  dark: titanium\nsetupVersion: 2\n`);
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agent Instructions\n");
  await fs.writeFile(path.join(dir, "extensions", "custom.ts"), "export default function() {}\n");
  await fs.writeFile(path.join(dir, "auth.json"), `secret-key-${name}`);
  return { root, dir };
}

export async function createBareRemote(root: string, name = "origin.git"): Promise<string> {
  const repo = path.join(root, name);
  await sh("git", ["init", "--bare", "-b", "main", repo]);
  return repo;
}

export function createFakeGh(overrides: Partial<GhClient> = {}): GhClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async available() {
      calls.push("available");
      return true;
    },
    async currentUser() {
      calls.push("currentUser");
      return "omp-tester";
    },
    async repoExists(id: string) {
      calls.push(`exists:${id}`);
      return false;
    },
    async isPrivate(id: string) {
      calls.push(`isPrivate:${id}`);
      return true;
    },
    async createPrivateRepo(id: string) {
      calls.push(`create:${id}`);
    },
    remoteUrl(id: string) {
      return `https://github.com/${id}.git`;
    },
    async setupGit() {
      calls.push("setupGit");
    },
    ...overrides,
  };
}
