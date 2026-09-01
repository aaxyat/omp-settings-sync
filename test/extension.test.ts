import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import gitSyncExtension from "../src/index.js";

test("extension registers /ompsync command and session listeners", () => {
  const commands: Record<string, unknown> = {};
  const events: Record<string, Function[]> = {};

  const mockPi: Partial<ExtensionAPI> = {
    setLabel(_label: string) {},
    registerCommand(name: string, def: unknown) {
      commands[name] = def;
    },
    on(event: string, handler: Function) {
      events[event] = events[event] ?? [];
      events[event].push(handler);
    },
  };

  gitSyncExtension(mockPi as ExtensionAPI);

  assert.ok(commands["ompsync"]);
  assert.ok(commands["gitsync"]);
  assert.ok(events["session_start"]?.length);
  assert.ok(events["session_shutdown"]?.length);

  const def = commands["ompsync"] as { getArgumentCompletions(prefix: string): Array<{ value: string }> | null };
  const rootCompletions = def.getArgumentCompletions("sy");
  const resetCompletions = def.getArgumentCompletions("re");
  assert.deepEqual(resetCompletions, [{ value: "reset", label: "reset" }]);

  const vaultCompletions = def.getArgumentCompletions("vault en");
  assert.deepEqual(vaultCompletions, [{ value: "vault enable", label: "vault enable" }]);
});


