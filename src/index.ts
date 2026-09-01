import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { dirOf } from "./config.js";
import { countAheadBehind, isSyncableRepo, pushOrigin, upstreamRef } from "./git.js";
import { isSubagentChild, shouldAutoSync, withLock, writeSyncState } from "./lock.js";
import { commitLocalChanges, prepareCommit, runInit, runLink, runSync, showStatus } from "./sync.js";

export default function gitSyncExtension(pi: ExtensionAPI) {
  pi.setLabel("OMP Config Git Sync");

  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    const [command = "status", ...rest] = args.trim().split(/\s+/);
    const arg = rest.join(" ");

    try {
      await withLock(ctx, async () => {
        if (command === "init") return runInit(arg, ctx);
        if (command === "link") return runLink(arg, ctx);
        if (command === "status") return showStatus(ctx);
        if (command === "sync") return runSync(ctx, { auto: false, push: true });
        if (command === "push") return runSync(ctx, { auto: false, push: true, skipPull: true });
        if (command === "pull") return runSync(ctx, { auto: false, push: false });
        throw new Error("Unknown command. Usage: /ompsync [init|link|status|sync|push|pull]");
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`omp-sync: ${msg}`, "error");
    }
  };

  const commandDef = {
    description: "Securely sync Oh My Pi config (init, link, status, sync, push, pull)",
    getArgumentCompletions: (prefix: string) => {
      const entries = ["init", "link", "status", "sync", "push", "pull"]
        .map((value) => ({ value, label: value }))
        .filter((x) => x.value.startsWith(prefix.trim()));
      return entries.length ? entries : null;
    },
    handler,
  };

  pi.registerCommand("ompsync", commandDef);
  pi.registerCommand("gitsync", commandDef);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (await shouldAutoSync()) {
      try {
        await withLock(ctx, async () => {
          await writeSyncState({ lastAutoSyncAt: new Date().toISOString() });
          await runSync(ctx, { auto: true, push: true });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`omp-sync skipped: ${msg}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
    const reason = typeof event === "object" && event && "reason" in event && typeof event.reason === "string" ? event.reason : undefined;
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
