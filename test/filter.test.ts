import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureFilter, formatFilterCommand, refreshMachineSidecar, resolveJsRuntime } from "../src/filter.js";
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

async function makeExecutable(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
  await fs.chmod(file, 0o755);
  return file;
}

test("resolveJsRuntime keeps process.execPath when it is node or bun", () => {
  assert.equal(resolveJsRuntime("/usr/local/bin/node", "", "linux"), "/usr/local/bin/node");
  assert.equal(resolveJsRuntime("/opt/bun/bin/BUN", "", "linux"), "/opt/bun/bin/BUN");
  assert.equal(resolveJsRuntime("C:\\Program Files\\nodejs\\node.exe", "", "win32"), "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(resolveJsRuntime("C:\\bun\\Bun.EXE", "", "win32"), "C:\\bun\\Bun.EXE");
});

test("resolveJsRuntime does not use the omp binary and resolves node from PATH instead", {
  skip: process.platform === "win32",
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-test-"));
  const ompDir = path.join(root, "omp-bin");
  const nodeDir = path.join(root, "node-bin");
  const bunDir = path.join(root, "bun-bin");
  const omp = await makeExecutable(ompDir, "omp");
  const node = await makeExecutable(nodeDir, "node");
  const bun = await makeExecutable(bunDir, "bun");

  // omp first on PATH, node later: node wins
  assert.equal(resolveJsRuntime(omp, [ompDir, nodeDir, bunDir].join(path.delimiter), "linux"), node);
  // node is preferred over bun even when bun comes first on PATH
  assert.equal(resolveJsRuntime(omp, [bunDir, nodeDir].join(path.delimiter), "linux"), node);
  // bun is used when node is unavailable
  assert.equal(resolveJsRuntime(omp, [ompDir, bunDir].join(path.delimiter), "linux"), bun);
});

test("resolveJsRuntime ignores non-executable candidates and falls back to the string 'node'", {
  skip: process.platform === "win32",
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-test-"));
  const dir = path.join(root, "bin");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "node"), "not executable");
  await fs.chmod(path.join(dir, "node"), 0o644);

  assert.equal(resolveJsRuntime("/opt/homebrew/bin/omp", dir, "linux"), "node");
  assert.equal(resolveJsRuntime("/opt/homebrew/bin/omp", "", "linux"), "node");
});

test("formatFilterCommand builds a quoted command around the given runtime", () => {
  assert.equal(
    formatFilterCommand("/repo/.git-sync/filter.mjs", "clean", "yaml", "/opt/homebrew/bin/node"),
    '"/opt/homebrew/bin/node" "/repo/.git-sync/filter.mjs" clean yaml'
  );
  assert.equal(
    formatFilterCommand("C:\\repo\\.git-sync\\filter.mjs", "smudge", "json", "C:\\nodejs\\node.exe"),
    '"C:/nodejs/node.exe" "C:/repo/.git-sync/filter.mjs" smudge json'
  );
});

test("ensureFilter never writes process.execPath of a non-node host into the git filter config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-filter-runtime-"));
  await sh("git", ["init", "-b", "main"], root);
  await ensureFilter(root, {});
  const { stdout } = await sh("git", ["config", "--get", "filter.omp-config-sync-yaml.clean"], root);
  const runtime = /^"([^"]+)"/.exec(stdout.trim())?.[1] ?? "";
  const base = path.basename(runtime).toLowerCase().replace(/\.exe$/, "");
  assert.match(base, /^(node|bun)$/);
});
