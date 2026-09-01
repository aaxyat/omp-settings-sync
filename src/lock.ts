import fs from "node:fs/promises";
import path from "node:path";
import type { Ctx, Deps } from "./config.js";
import { dirOf, readConfig } from "./config.js";
import { isSyncableRepo } from "./git.js";

export function stateDir(dir: string): string {
  return path.join(dir, ".git-sync");
}

export function lockPath(dir: string): string {
  return path.join(stateDir(dir), "lock");
}

export function statePath(dir: string): string {
  return path.join(stateDir(dir), "state.json");
}

export function isSubagentChild(): boolean {
  if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) return true;
  if (Number(process.env.OMP_SUBAGENT_DEPTH ?? "0") > 0) return true;
  if (process.env.OMP_IS_SUBAGENT === "true" || process.env.OMP_IS_SUBAGENT === "1") return true;
  return false;
}

export async function readSyncState(dir: string): Promise<{ lastAutoSyncAt?: string }> {
  try {
    const raw = await fs.readFile(statePath(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "lastAutoSyncAt" in parsed && typeof parsed.lastAutoSyncAt === "string") {
      return { lastAutoSyncAt: parsed.lastAutoSyncAt };
    }
    return {};
  } catch {
    return {};
  }
}

export async function writeSyncState(state: { lastAutoSyncAt: string }, dir = dirOf()): Promise<void> {
  await fs.mkdir(stateDir(dir), { recursive: true });
  await fs.writeFile(statePath(dir), JSON.stringify(state, null, 2) + "\n");
}

export async function shouldAutoSync(deps?: Deps): Promise<boolean> {
  const dir = dirOf(deps);
  if (isSubagentChild() || !(await isSyncableRepo(dir))) return false;

  const state = await readSyncState(dir);
  if (!state.lastAutoSyncAt) return true;

  const config = await readConfig(deps);
  const intervalMs = (config.autoSyncIntervalMinutes ?? 5) * 60_000;
  return Date.now() - Date.parse(state.lastAutoSyncAt) >= intervalMs;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function withLock<T>(ctx: Ctx, fn: () => Promise<T>, deps?: Deps): Promise<T | undefined> {
  const dir = dirOf(deps);
  await fs.mkdir(stateDir(dir), { recursive: true });
  const lock = lockPath(dir);

  try {
    const handle = await fs.open(lock, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const lockRaw = await fs.readFile(lock, "utf8");
      const lockData: unknown = JSON.parse(lockRaw);
      if (
        lockData &&
        typeof lockData === "object" &&
        "pid" in lockData &&
        typeof lockData.pid === "number" &&
        "startedAt" in lockData &&
        typeof lockData.startedAt === "string"
      ) {
        if (isProcessAlive(lockData.pid)) {
          if (Date.now() - Date.parse(lockData.startedAt) < 600_000) {
            return undefined;
          }
        }
      }
    } catch {}
    await fs.rm(lock, { force: true });
    return withLock(ctx, fn, deps);
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}
