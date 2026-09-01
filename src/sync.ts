import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Ctx, Deps } from "./config.js";
import { dirOf, readConfig } from "./config.js";
import { ensureAttributes, ensureFilter, refreshMachineSidecar } from "./filter.js";
import { DEFAULT_SYNC_REPO_NAME, defaultGh, LIKELY_SYNC_REPO_NAMES, parseRepoReference, remoteFromArg } from "./gh.js";
import {
  countAheadBehind,
  fetchOrigin,
  git,
  gitRaw,
  hasCommits,
  hasDotGit,
  integrateUpstream,
  isSyncableRepo,
  pushOrigin,
  upstreamRef,
} from "./git.js";
import {
  ensureIgnoreRules,
  ensureInfoExclude,
  isDenied,
  stagedSecretFiles,
  trackedSecretFiles,
} from "./security.js";
import {
  cacheVaultPassword,
  clearCachedVaultPassword,
  decryptPayload,
  deleteVaultFile,
  encryptPayload,
  getCachedVaultPassword,
  getVaultStatus,
  hasVaultFile,
  packSensitiveFiles,
  readVaultFile,
  unpackSensitiveFiles,
  writeVaultFile,
} from "./vault.js";

const STATUS_KEY = "omp-git-sync";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: Ctx, text: string, level: "info" | "warning" | "error", deps?: Deps) {
  if (deps?.notify) {
    deps.notify(text, level);
  } else if (ctx?.hasUI && ctx.ui) {
    ctx.ui.notify(text, level);
  }
}

export async function prepareCommit(deps?: Deps, ctx?: Ctx) {
  const config = await readConfig(deps, ctx);
  const dir = dirOf(deps);
  await ensureIgnoreRules(dir, config);
  await ensureInfoExclude(dir);
  await ensureAttributes(dir);
  await ensureFilter(dir, config);
  await refreshMachineSidecar(dir, config);

  // If vault is enabled and unlocked on this machine, update vault.enc with latest local credentials
  const vaultStatus = await getVaultStatus(dir);
  if (vaultStatus === "unlocked") {
    const password = await getCachedVaultPassword(dir);
    if (password) {
      const payload = await packSensitiveFiles(dir);
      if (Object.keys(payload.files).length > 0) {
        const encrypted = encryptPayload(payload, password);
        await writeVaultFile(dir, encrypted);
      }
    }
  }

  return config;
}

export async function commitLocalChanges(deps?: Deps, commitMessage?: string, ctx?: Ctx): Promise<boolean> {
  const dir = dirOf(deps);
  await prepareCommit(deps, ctx);

  const status = (await git(["status", "--porcelain"], dir)).stdout.trim();
  if (!status) return false;

  await git(["add", "-A"], dir);
  const bad = await stagedSecretFiles(dir);
  if (bad.length) {
    await git(["reset"], dir);
    throw new Error(`REFUSED to commit sensitive paths: ${bad.join(", ")}. Remove with git rm --cached <file>.`);
  }

  const config = await readConfig(deps, ctx);
  const suffix = config.includeHostname === false ? "" : ` from ${os.hostname()}`;
  await git(["commit", "-m", commitMessage ?? `omp config: auto-sync${suffix}`], dir);
  return true;
}

export async function runInit(
  arg: string,
  ctx?: Ctx,
  deps?: Deps,
  options?: { password?: string; enableVault?: boolean }
): Promise<void> {
  const dir = dirOf(deps);
  await fs.mkdir(dir, { recursive: true });
  if (await isSyncableRepo(dir)) {
    throw new Error("already initialized; use /ompsync sync");
  }

  // Check if vault encryption should be set up
  let password = options?.password;
  if (password === undefined && options?.enableVault !== false && ctx?.hasUI && ctx.ui) {
    const wantVault = ctx.ui.confirm
      ? await ctx.ui.confirm(
          "Encrypted Credentials Sync",
          "Do you want to securely sync session tokens and login credentials with a password?"
        )
      : false;
    if (wantVault && ctx.ui.input) {
      const pass = await ctx.ui.input("Vault Passphrase", "Enter a passphrase to encrypt your credentials vault:");
      if (pass && pass.trim()) {
        password = pass.trim();
      }
    }
  }

  if (password) {
    const payload = await packSensitiveFiles(dir);
    const encrypted = encryptPayload(payload, password);
    await writeVaultFile(dir, encrypted);
    await cacheVaultPassword(dir, password);
  }

  const config = await readConfig(deps, ctx);
  await ensureIgnoreRules(dir, config);
  if (!(await hasDotGit(dir))) {
    await git(["init", "-b", "main"], dir);
  }
  await ensureInfoExclude(dir);

  const tracked = await trackedSecretFiles(dir);
  if (tracked.length) {
    throw new Error(`tracked sensitive files: ${tracked.join(", ")}. Remove with git rm --cached <file>.`);
  }

  await commitLocalChanges(deps, "omp config: initial sync setup", ctx);

  let remote = remoteFromArg(arg, "");
  if (!remote) {
    const gh = deps?.gh ?? defaultGh;
    if (!(await gh.available())) {
      notify(ctx, "omp-sync: initial commit created. Create a private repo, then run /ompsync init <url>.", "warning", deps);
      return;
    }
    const owner = await gh.currentUser();
    const ref = parseRepoReference(arg || DEFAULT_SYNC_REPO_NAME, owner);
    if (!ref) throw new Error(`invalid repository reference: ${arg}`);
    const id = `${ref.owner}/${ref.name}`;
    if (await gh.repoExists(id)) {
      throw new Error("repository already exists; use /ompsync link instead");
    }
    await gh.createPrivateRepo(id);
    remote = gh.remoteUrl(id);
  }

  await git(["remote", "add", "origin", remote], dir);
  if (!(await pushOrigin(true, dir))) {
    throw new Error("initial push failed");
  }

  notify(
    ctx,
    `omp-sync: initialized and pushed private repository (${password ? "with encrypted vault" : "config only"}).`,
    "info",
    deps
  );
}

async function defaultBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await git(["ls-remote", "--symref", "origin", "HEAD"], dir);
    const match = stdout.match(/ref: refs\/heads\/([^\s]+)\s+HEAD/);
    return match?.[1] ?? "main";
  } catch {
    return "main";
  }
}

async function backupConflicts(dir: string, branch: string): Promise<string[]> {
  const { stdout } = await git(["ls-tree", "-r", "--name-only", "-z", `origin/${branch}`], dir);
  const backups: string[] = [];
  for (const rel of stdout.split("\0").filter(Boolean)) {
    const target = path.join(dir, rel);
    try {
      await fs.lstat(target);
    } catch {
      continue;
    }
    const local = await fs.readFile(target).catch(() => undefined);
    const remote = await gitRaw(["show", `origin/${branch}:${rel}`], dir)
      .then((x) => x.stdout)
      .catch(() => undefined);
    if (local && remote && !local.equals(remote)) {
      await fs.rename(target, `${target}.local-backup`);
      backups.push(rel);
    }
  }
  return backups;
}

export async function runLink(
  arg: string,
  ctx?: Ctx,
  deps?: Deps,
  options?: { password?: string }
): Promise<void> {
  const dir = dirOf(deps);
  if (await isSyncableRepo(dir)) {
    throw new Error("already linked; use /ompsync sync");
  }

  const gh = deps?.gh ?? defaultGh;
  let remote = remoteFromArg(arg, "");
  if (!remote) {
    if (!(await gh.available())) {
      notify(ctx, "omp-sync: provide a repo URL, or install and authenticate gh.", "warning", deps);
      return;
    }
    const owner = await gh.currentUser();
    for (const name of LIKELY_SYNC_REPO_NAMES) {
      if (await gh.repoExists(`${owner}/${name}`)) {
        remote = gh.remoteUrl(`${owner}/${name}`);
        break;
      }
    }
    if (!remote) throw new Error("no sync repository found; provide its URL");
  }

  await fs.mkdir(dir, { recursive: true });
  if ((await hasDotGit(dir)) && (await hasCommits(dir))) {
    throw new Error(`existing git history in ${dir} has no 'origin' remote; backup or clean before linking`);
  }

  const config = await readConfig(deps, ctx);
  if (!(await hasDotGit(dir))) {
    await git(["init", "-b", "main"], dir);
  }
  await ensureIgnoreRules(dir, config);
  await ensureInfoExclude(dir);
  await ensureAttributes(dir);
  await ensureFilter(dir, config);
  await refreshMachineSidecar(dir, config);

  await git(["remote", "add", "origin", remote], dir);
  await git(["fetch", "origin"], dir);

  const branch = await defaultBranch(dir);
  const backups = await backupConflicts(dir, branch);

  try {
    await git(["checkout", "-B", branch, `origin/${branch}`], dir);
  } catch (error) {
    const output = message(error);
    const refused =
      output.match(/would be overwritten by checkout:\n([\s\S]*?)Please move or remove/)?.[1]?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
    for (const relative of refused) {
      if (isDenied(relative)) continue;
      const target = path.join(dir, relative);
      try {
        await fs.rename(target, `${target}.local-backup`);
        backups.push(relative);
      } catch {}
    }
    if (refused.length) {
      try {
        await git(["checkout", "-B", branch, `origin/${branch}`], dir);
      } catch (retry) {
        throw new Error(`${message(retry)}\nResolve manually in ${dir}`);
      }
    } else {
      throw new Error(`${output}\nResolve manually in ${dir}`);
    }
  }

  // Handle encrypted vault if present
  let vaultDecrypted = false;
  const hasVault = await hasVaultFile(dir);
  if (hasVault) {
    let password = options?.password;
    if (password === undefined && ctx?.hasUI && ctx.ui && ctx.ui.input) {
      const entered = await ctx.ui.input(
        "Encrypted Credentials Vault",
        "Remote repository contains an encrypted credentials vault. Enter passphrase to decrypt session tokens and login (or leave blank to skip):"
      );
      if (entered && entered.trim()) {
        password = entered.trim();
      }
    }

    if (password) {
      const vaultRaw = await readVaultFile(dir);
      if (vaultRaw) {
        try {
          const payload = decryptPayload(vaultRaw, password);
          const restored = await unpackSensitiveFiles(dir, payload);
          await cacheVaultPassword(dir, password);
          vaultDecrypted = true;
          notify(ctx, `omp-sync: decrypted credentials vault and restored: ${restored.join(", ")}`, "info", deps);
        } catch {
          notify(
            ctx,
            "omp-sync: incorrect passphrase. Unencrypted config was linked. Run '/ompsync unlock' later.",
            "warning",
            deps
          );
        }
      }
    } else {
      notify(
        ctx,
        "omp-sync: credentials vault is locked. Run '/ompsync unlock' when you wish to decrypt session tokens.",
        "info",
        deps
      );
    }
  }

  const tracked = await trackedSecretFiles(dir);
  if (tracked.length) {
    notify(ctx, `omp-sync: remote tracks sensitive files: ${tracked.join(", ")}. Remove with git rm --cached <file>.`, "warning", deps);
  }

  notify(
    ctx,
    `omp-sync: linked — run /reload to apply pulled config.${backups.length ? ` Backed up: ${backups.join(", ")}.` : ""}${
      vaultDecrypted ? " (Vault restored)" : ""
    }`,
    "info",
    deps
  );
}

export async function showStatus(ctx: Ctx, deps?: Deps): Promise<void> {
  const dir = dirOf(deps);
  if (!(await isSyncableRepo(dir))) {
    notify(ctx, `omp-sync: ${dir} is not initialized. Run /ompsync init.`, "warning", deps);
    return;
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).stdout.trim();
  const dirty = (await git(["status", "--porcelain"], dir)).stdout.trim();
  const bad = await trackedSecretFiles(dir);
  const vaultStatus = await getVaultStatus(dir);

  notify(
    ctx,
    `repo: ${dir}\nbranch: ${branch}\nvault: ${vaultStatus}\nuncommitted changes: ${dirty ? "yes" : "none"}${
      bad.length ? `\nWARNING tracked sensitive files: ${bad.join(", ")}` : ""
    }`,
    bad.length ? "warning" : "info",
    deps
  );
}

export async function runSync(
  ctx: Ctx,
  options: { auto: boolean; push: boolean; skipPull?: boolean },
  deps?: Deps
): Promise<void> {
  const dir = dirOf(deps);
  if (!(await isSyncableRepo(dir))) {
    if (!options.auto) {
      notify(ctx, `omp-sync: no git repo with an 'origin' remote in ${dir}. Run /ompsync init.`, "warning", deps);
    }
    return;
  }

  if (ctx?.hasUI && ctx.ui) ctx.ui.setStatus(STATUS_KEY, "syncing");

  try {
    await prepareCommit(deps, ctx);
    const tracked = await trackedSecretFiles(dir);
    if (tracked.length) {
      notify(ctx, `omp-sync: tracked sensitive files: ${tracked.join(", ")}. Remove with git rm --cached.`, "warning", deps);
    }

    const changed: string[] = [];
    if (await commitLocalChanges(deps, undefined, ctx)) {
      changed.push("committed local changes");
    }

    if (!options.skipPull) {
      if (!(await fetchOrigin(dir))) {
        if (!options.auto) notify(ctx, "omp-sync: fetch failed; skipped pull/push.", "warning", deps);
        return;
      }

      const upstream = await upstreamRef(dir);
      if (upstream) {
        const { behind } = await countAheadBehind(upstream, dir);
        if (behind > 0) {
          if (!(await integrateUpstream(upstream, dir))) {
            throw new Error(`local and remote diverged with conflicts; rebase aborted in ${dir}`);
          }
          changed.push("pulled updates");

          // If remote updated vault.enc and we have a cached password, update local credentials
          const vaultStatus = await getVaultStatus(dir);
          if (vaultStatus === "unlocked") {
            const password = await getCachedVaultPassword(dir);
            const vaultRaw = await readVaultFile(dir);
            if (password && vaultRaw) {
              try {
                const payload = decryptPayload(vaultRaw, password);
                await unpackSensitiveFiles(dir, payload);
              } catch {}
            }
          }
        }
      }
    }

    if (options.push) {
      const upstream = await upstreamRef(dir);
      if (!upstream) {
        if (await pushOrigin(true, dir)) changed.push("pushed");
      } else {
        const { ahead } = await countAheadBehind(upstream, dir);
        if (ahead > 0) {
          if (await pushOrigin(false, dir)) changed.push("pushed");
        }
      }
    }

    if (changed.some((x) => x.startsWith("pulled"))) {
      notify(ctx, `omp-sync: ${changed.join(", ")}. Run /reload to apply pulled config.`, "info", deps);
    } else if (!options.auto) {
      notify(ctx, changed.length ? `omp-sync: ${changed.join(", ")}.` : "omp-sync: already up to date.", "info", deps);
    }
  } finally {
    if (ctx?.hasUI && ctx.ui) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export async function runUnlockVault(passwordArg?: string, ctx?: Ctx, deps?: Deps): Promise<void> {
  const dir = dirOf(deps);
  if (!(await hasVaultFile(dir))) {
    throw new Error("No encrypted vault file (vault.enc) found. Use '/ompsync vault enable' to create one.");
  }

  let password = passwordArg;
  if (!password && ctx?.hasUI && ctx.ui && ctx.ui.input) {
    const entered = await ctx.ui.input("Unlock Vault", "Enter passphrase to decrypt credentials vault:");
    if (entered && entered.trim()) {
      password = entered.trim();
    }
  }

  if (!password) {
    throw new Error("Passphrase required to unlock vault.");
  }

  const raw = await readVaultFile(dir);
  if (!raw) throw new Error("Vault file is empty.");

  const payload = decryptPayload(raw, password);
  const restored = await unpackSensitiveFiles(dir, payload);
  await cacheVaultPassword(dir, password);

  notify(ctx, `omp-sync: vault unlocked. Restored: ${restored.join(", ")}`, "info", deps);
}

export async function runEnableVault(passwordArg?: string, ctx?: Ctx, deps?: Deps): Promise<void> {
  const dir = dirOf(deps);
  let password = passwordArg;
  if (!password && ctx?.hasUI && ctx.ui && ctx.ui.input) {
    const entered = await ctx.ui.input("Enable Vault", "Enter passphrase to encrypt credentials vault:");
    if (entered && entered.trim()) {
      password = entered.trim();
    }
  }

  if (!password) {
    throw new Error("Passphrase required to enable vault.");
  }

  const payload = await packSensitiveFiles(dir);
  const encrypted = encryptPayload(payload, password);
  await writeVaultFile(dir, encrypted);
  await cacheVaultPassword(dir, password);

  if (await isSyncableRepo(dir)) {
    await commitLocalChanges(deps, "omp config: enable encrypted credentials vault", ctx);
    const upstream = await upstreamRef(dir);
    await pushOrigin(!upstream, dir);
  }

  notify(ctx, "omp-sync: encrypted credentials vault enabled and saved.", "info", deps);
}

export async function runDisableVault(ctx?: Ctx, deps?: Deps): Promise<void> {
  const dir = dirOf(deps);
  await deleteVaultFile(dir);
  await clearCachedVaultPassword(dir);

  if (await isSyncableRepo(dir)) {
    await git(["rm", "-f", "vault.enc"], dir).catch(() => {});
    await commitLocalChanges(deps, "omp config: disable encrypted credentials vault", ctx);
    const upstream = await upstreamRef(dir);
    await pushOrigin(!upstream, dir);
  }

  notify(ctx, "omp-sync: credentials vault disabled and removed from sync.", "info", deps);
}

export async function runLockVault(ctx?: Ctx, deps?: Deps): Promise<void> {
  const dir = dirOf(deps);
  await clearCachedVaultPassword(dir);
  notify(ctx, "omp-sync: credentials vault locked on this machine.", "info", deps);
}
