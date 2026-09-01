import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureIgnoreRules, isDenied } from "../src/security.js";

test("isDenied blocks all secrets, databases, runtime state, and local credentials", () => {
  const blocked = [
    "auth.json",
    "auth-broker.json",
    "api_key.txt",
    "token.secret",
    "agent.db",
    "models.db-wal",
    "history.db-shm",
    "state.sqlite",
    "sessions/abc/session.jsonl",
    "blobs/123",
    "terminal-sessions/pts-1",
    "natives/18.0.10",
    "logs/omp.log",
    "run/daemons/pid.json",
    "wt/feature-branch",
    "cache/composer/welcome.json",
    "last-changelog-version",
    ".env",
    "prod.env",
    "config.local.yml",
    "mcp.local.json",
    "node_modules/pkg/index.js",
  ];
  for (const file of blocked) {
    assert.ok(isDenied(file), `Expected denied: ${file}`);
  }

  const allowed = [
    "config.yml",
    "mcp.json",
    "settings.json",
    "AGENTS.md",
    "Agents.md",
    "omp-sync.jsonc",
    ".gitignore",
    ".gitattributes",
    "extensions/tps.ts",
    "skills/review.md",
    "agents/scout.json",
    "themes/titanium.json",
    "prompts/code.md",
    "chains/ci.md",
  ];
  for (const file of allowed) {
    assert.ok(!isDenied(file), `Expected allowed: ${file}`);
  }
});

test("ensureIgnoreRules writes managed block preserving user rules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ignore-test-"));
  await fs.writeFile(path.join(root, ".gitignore"), "# Custom user comment\n*.custom-keep\n");

  await ensureIgnoreRules(root);
  const content = await fs.readFile(path.join(root, ".gitignore"), "utf8");

  assert.ok(content.includes("# Custom user comment"));
  assert.ok(content.includes("# >>> omp-config-sync managed"));
  assert.ok(content.includes("!config.yml"));
  assert.ok(content.includes("!mcp.json"));
  assert.ok(content.includes("!AGENTS.md"));
  assert.ok(content.includes("*.db*"));
});
