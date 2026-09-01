import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureFilter, refreshMachineSidecar } from "../src/filter.js";
import { sh } from "./helpers.js";

test("filter cleans machine keys and smudges them back for YAML config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-filter-test-"));
  await sh("git", ["init", "-b", "main"], root);

  const initialConfig = `theme:\n  dark: titanium\nsetupVersion: 2\nshellPath: /bin/zsh\n`;
  await fs.writeFile(path.join(root, "config.yml"), initialConfig);

  await ensureFilter(root, { machineLocalYamlKeys: ["setupVersion", "shellPath"] });
  await refreshMachineSidecar(root, { machineLocalYamlKeys: ["setupVersion", "shellPath"] });

  const filterScript = path.join(root, ".git-sync", "filter.mjs");
  assert.ok(await fs.stat(filterScript));

  // Run clean filter over stdin
  const cleanResult = await new Promise<string>((resolve, reject) => {
    const p = execFileCb(process.execPath, [filterScript, "clean", "yaml"], (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
    p.stdin?.end(initialConfig);
  });

  assert.doesNotMatch(cleanResult, /setupVersion/);
  assert.doesNotMatch(cleanResult, /shellPath/);
  assert.match(cleanResult, /titanium/);

  // Run smudge filter over stdin
  const smudgeResult = await new Promise<string>((resolve, reject) => {
    const p = execFileCb(process.execPath, [filterScript, "smudge", "yaml"], (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
    p.stdin?.end(cleanResult);
  });

  assert.match(smudgeResult, /setupVersion/);
  assert.match(smudgeResult, /shellPath/);
  assert.match(smudgeResult, /titanium/);
});
