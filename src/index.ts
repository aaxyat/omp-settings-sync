import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { dirOf } from "./config.js";
import { countAheadBehind, isSyncableRepo, pushOrigin, upstreamRef } from "./git.js";
import { isSubagentChild, withLock, writeSyncState } from "./lock.js";
import {
  checkAndBackgroundSync,
  commitLocalChanges,
  prepareCommit,
  runDisableVault,
  runEnableVault,
  runInit,
  runLink,
  runLockVault,
  runReset,
  runSync,
  runUnlockVault,
  showStatus,
} from "./sync.js";

const BACKGROUND_SYNC_INTERVAL_MS = 60_000; // 1 minute

export default function gitSyncExtension(pi: ExtensionAPI) {
  pi.setLabel("OMP Config Git Sync");

  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const [command = "status", ...rest] = args.trim().split(/\s+/);
    const arg = rest.join(" ");

    try {
      await withLock(ctx, async () => {
        if (command === "init") {
          return runInit(arg, ctx);
        }
        if (command === "link") {
          return runLink(arg, ctx);
        }
        if (command === "status") {
          return showStatus(ctx);
        }
        if (command === "reset" || command === "restore") {
          return runReset(ctx);
        }
        if (command === "sync") {
          const discardLocal = /\b(--discard-local|--force|-f|--hard)\b/i.test(arg);
          return runSync(ctx, { auto: false, push: !discardLocal, discardLocal });
        }
        if (command === "push") {
          return runSync(ctx, { auto: false, push: true, skipPull: true });
        }
        if (command === "pull") {
          const discardLocal = /\b(--discard-local|--force|-f|--hard)\b/i.test(arg);
          return runSync(ctx, { auto: false, push: false, discardLocal });
        }
        if (command === "unlock") {
          return runUnlockVault(arg || undefined, ctx);
        }
        if (command === "lock") {
          return runLockVault(ctx);
        }
        if (command === "vault") {
          const [subcommand = "status", ...subRest] = arg.trim().split(/\s+/);
          const subArg = subRest.join(" ");
          if (subcommand === "enable") {
            return runEnableVault(subArg || undefined, ctx);
          }
          if (subcommand === "disable") {
            return runDisableVault(ctx);
          }
          if (subcommand === "unlock") {
            return runUnlockVault(subArg || undefined, ctx);
          }
          if (subcommand === "lock") {
            return runLockVault(ctx);
          }
          if (subcommand === "status") {
            return showStatus(ctx);
          }
          throw new Error("Unknown vault subcommand. Usage: /ompsync vault [enable|disable|unlock|lock|status]");
        }
        throw new Error("Unknown command. Usage: /ompsync [init|link|status|sync|reset|push|pull|unlock|lock|vault]");
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`omp-sync: ${msg}`, "error");
    }
  };

  const commandDef = {
    description: "Securely sync Oh My Pi config and encrypted credentials vault",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      if (trimmed.startsWith("vault ")) {
        const subEntries = ["enable", "disable", "unlock", "lock", "status"]
          .map((sub) => ({ value: `vault ${sub}`, label: `vault ${sub}` }))
          .filter((x) => x.value.startsWith(trimmed));
        return subEntries.length ? subEntries : null;
      }
      const entries = ["init", "link", "status", "sync", "reset", "push", "pull", "unlock", "lock", "vault"]
        .map((value) => ({ value, label: value }))
        .filter((x) => x.value.startsWith(prefix.trim()));
      return entries.length ? entries : null;
    },
    handler,
  };


  pi.registerCommand("ompsync", commandDef);
  pi.registerCommand("gitsync", commandDef);


  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // 1. Sync immediately on opening / startup
    if (!isSubagentChild() && (await isSyncableRepo())) {
      try {
        await withLock(ctx, async () => {
          await writeSyncState({ lastAutoSyncAt: new Date().toISOString() });
          await runSync(ctx, { auto: true, push: true });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI && ctx.ui) ctx.ui.notify(`omp-sync skipped: ${msg}`, "warning");
      }
    }

    // 2. Schedule 1-minute background sync interval to sync whenever changes occur
    const scheduleInterval =
      typeof ctx.setInterval === "function"
        ? (fn: () => void, ms: number) => ctx.setInterval(fn, ms)
        : (fn: () => void, ms: number) => {
            const timer = setInterval(fn, ms);
            timer.unref?.();
            return timer;
          };

    scheduleInterval(async () => {
      try {
        await checkAndBackgroundSync(ctx);
      } catch {}
    }, BACKGROUND_SYNC_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    const reason =
      typeof event === "object" && event && "reason" in event && typeof event.reason === "string"
        ? event.reason
        : undefined;
    if (reason === "reload" || isSubagentChild() || !(await isSyncableRepo())) return;

    try {
      await withLock(ctx, async () => {
        await prepareCommit(undefined, ctx);
        await commitLocalChanges(undefined, undefined, ctx);
        const dir = dirOf();
        const upstream = await upstreamRef(dir);
        if (!upstream) {
          await pushOrigin(true, dir);
        } else {
          const { ahead, behind } = await countAheadBehind(upstream, dir);
          if (ahead > 0 && behind === 0) {
            await pushOrigin(false, dir);
          }
        }
      });
    } catch {}
  });
}
