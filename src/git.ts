import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dirOf } from "./config.js";

const exec = promisify(execFile);

export function gitEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: path.dirname(dir),
  };
}

export function git(args: string[], dir: string, timeout = 15_000) {
  return exec("git", args, {
    cwd: dir,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(dir),
  });
}

export function gitRaw(args: string[], dir: string): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return exec("git", args, {
    cwd: dir,
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
    env: gitEnv(dir),
  }) as unknown as Promise<{ stdout: Buffer; stderr: Buffer }>;
}

export async function hasDotGit(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "HEAD"], dir);
    return true;
  } catch {
    return false;
  }
}

export async function isSyncableRepo(dir = dirOf()): Promise<boolean> {
  if (!(await hasDotGit(dir))) return false;
  try {
    const { stdout } = await git(["remote"], dir);
    return stdout.split("\n").includes("origin");
  } catch {
    return false;
  }
}

export async function upstreamRef(dir: string): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--abbrev-ref", "@{u}"], dir)).stdout.trim();
  } catch {
    return undefined;
  }
}

export async function countAheadBehind(upstream: string, dir: string): Promise<{ behind: number; ahead: number }> {
  const { stdout } = await git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], dir);
  const [behind = "0", ahead = "0"] = stdout.trim().split(/\s+/);
  return { behind: Number(behind), ahead: Number(ahead) };
}

export async function fetchOrigin(dir: string): Promise<boolean> {
  try {
    await git(["fetch", "origin"], dir);
    return true;
  } catch {
    return false;
  }
}

export async function integrateUpstream(upstream: string, dir: string): Promise<boolean> {
  try {
    await git(["merge", "--ff-only", upstream], dir);
    return true;
  } catch {}
  try {
    await git(["rebase", upstream], dir);
    return true;
  } catch {
    try {
      await git(["rebase", "--abort"], dir);
    } catch {}
    return false;
  }
}

export async function pushOrigin(first: boolean, dir: string): Promise<boolean> {
  try {
    await git(first ? ["push", "-u", "origin", "HEAD"] : ["push"], dir, 20_000);
    return true;
  } catch {
    return false;
  }
}
