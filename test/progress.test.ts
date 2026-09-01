import assert from "node:assert/strict";
import test from "node:test";
import { renderProgressBar, updateSyncProgress, clearSyncProgress, STATUS_KEY } from "../src/sync.js";

test("renderProgressBar renders correct bar and percentage", () => {
  assert.equal(renderProgressBar(0, "Starting..."), "🔄 Sync [░░░░░░░░░░] 0% Starting...");
  assert.equal(renderProgressBar(50, "Fetching..."), "🔄 Sync [█████░░░░░] 50% Fetching...");
  assert.equal(renderProgressBar(100, "Complete"), "🔄 Sync [██████████] 100% Complete");
  assert.equal(renderProgressBar(35, "Working..."), "🔄 Sync [████░░░░░░] 35% Working...");
});

test("updateSyncProgress and clearSyncProgress call UI methods safely", () => {
  const statusUpdates: Record<string, string | undefined> = {};
  let workingMessage: string | undefined = undefined;

  const mockCtx = {
    hasUI: true,
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusUpdates[key] = text;
      },
      setWorkingMessage(msg?: string) {
        workingMessage = msg;
      },
      notify() {},
    },
  };

  updateSyncProgress(mockCtx, 50, "Testing...");
  assert.match(statusUpdates[STATUS_KEY] ?? "", /50% Testing\.\.\./);
  assert.match(workingMessage ?? "", /50% Testing\.\.\./);

  clearSyncProgress(mockCtx);
  assert.equal(statusUpdates[STATUS_KEY], undefined);
  assert.equal(workingMessage, undefined);
});
