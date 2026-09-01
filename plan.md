# Oh My Pi Config Sync (`omp-config-sync`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reimplement and adapt `pi-config-sync` into `omp-config-sync`, a native configuration synchronization extension for the Oh My Pi (`omp.sh`) agent harness that securely synchronizes `~/.omp/agent` (and profile configurations) via a private Git repository with 4-tier secret guards, dual YAML/JSON clean/smudge filtering for machine-local settings, OMP subagent isolation, and zero-touch GitHub CLI onboarding.

**Architecture:** In-place Git repository residing directly in `~/.omp/agent` (or `~/.omp/profiles/<profile>/agent`) ensuring transparent history without shadow copies; multi-layered security guards (allowlist `.gitignore`, `.git/info/exclude`, pre-commit staging blocker, and tracked file scanner); a zero-dependency dual YAML & JSON clean/smudge filter managing machine-local and sensitive settings; asynchronous rate-limited lifecycle sync (`session_start`, `session_shutdown`); PID-liveness file locking; and `/ompsync` / `/gitsync` slash commands.

**Tech Stack:** TypeScript, Node.js (v22+ ESM), `@oh-my-pi/pi-coding-agent`, native Node.js `child_process` (`git`, `gh`), zero external runtime dependencies.

**Spec:** Reimplementation of `pi-config-sync` tailored specifically for Oh My Pi (`omp.sh` v18+).

---

## Global Constraints

- **Directory Boundary:** Sync operates on `~/.omp/agent` (or `~/.omp/profiles/<profile>/agent` when `OMP_PROFILE` is set), overridable via `PI_CODING_AGENT_DIR`. `GIT_CEILING_DIRECTORIES` is set to the parent directory to prevent git traversal into user home dotfiles.
- **Runtime & Dependencies:** Node.js v22+ ESM. Zero external production runtime dependencies — git filters and YAML/JSON processors must run strictly with Node.js built-ins.
- **Security Absolute:** Deny by default. Secrets, tokens, credentials, SQLite databases (`agent.db*`, `models.db*`, `history.db*`), sessions, blobs, worktrees, and ephemeral caches must NEVER be staged or committed under any circumstance, even with `git add -f`.
- **Non-Destructive Operations:** Rebase aborts on conflicts without altering the working tree; link conflicts preserve local files with `.local-backup` extensions; force-pushing is strictly prohibited.
- **Subagent Immunity:** Background auto-sync is disabled inside subagent processes (`PI_SUBAGENT_DEPTH > 0` or `OMP_SUBAGENT_DEPTH > 0` or `OMP_IS_SUBAGENT=1`).

---

## Architectural Deep Dive & Comparative Matrix

### Pi Agent (`pi`) vs. Oh My Pi (`omp.sh`)

| Feature / Dimension | Pi Agent (`pi-config-sync`) | Oh My Pi (`omp-config-sync`) |
| :--- | :--- | :--- |
| **Default Agent Directory** | `~/.pi/agent` | `~/.omp/agent` (or `~/.omp/profiles/<profile>/agent`) |
| **Environment Variable Overrides** | `PI_CODING_AGENT_DIR` | `OMP_PROFILE`, `PI_CODING_AGENT_DIR` |
| **Package & Type Identity** | `@earendil-works/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` |
| **Primary Configuration Files** | `settings.json` | `config.yml` (YAML), `mcp.json` (JSON), `AGENTS.md` / `Agents.md` |
| **Clean/Smudge Filter Targets** | `settings.json` (JSON only) | `config.yml` (YAML) and `mcp.json` / `settings.json` (JSON) |
| **Machine-Local & Sensitive Keys** | `lastChangelogVersion`, `shellPath` | `images.urls.credentials`, `dev.autoqaPush.token`, `searxng.*`, `hindsight.*`, `auth.broker.*`, `setupVersion`, `shellPath`, `python.interpreter`, etc. |
| **Databases & Runtime State** | `sessions/`, `state/` | `agent.db*`, `models.db*`, `history.db*` (SQLite + WAL/SHM), `blobs/`, `terminal-sessions/`, `cache/`, `natives/`, `logs/`, `run/`, `wt/`, `last-changelog-version` |
| **Subagent Hierarchy Detection** | `PI_SUBAGENT_DEPTH` | `OMP_SUBAGENT_DEPTH`, `PI_SUBAGENT_DEPTH`, `OMP_IS_SUBAGENT` |
| **Default GitHub Repositories** | `pi-agent-config`, `pi-config` | `omp-agent-config`, `my-omp-config`, `omp-config`, `dotfiles-omp`, `pi-agent-config` |
| **Slash Commands** | `/gitsync` | `/ompsync` (primary) and `/gitsync` (alias) |
| **Package Distribution** | `pi install npm:pi-config-sync` | `omp plugin install` / `omp plugin link` / `~/.omp/agent/extensions/` |

---

## 4-Tier Security Model

```
                    ┌────────────────────────────────────────────────────────┐
                    │                      User Action                       │
                    │         (/ompsync sync, session_start, etc.)           │
                    └───────────────────────────┬────────────────────────────┘
                                                │
                                                ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Inverted Allowlist .gitignore                                                                    │
│   * (ignore everything)                                                                                  │
│   !config.yml, !mcp.json, !settings.json, !AGENTS.md, !extensions/**, !skills/**, !agents/**, etc.       │
│   Hard Denylist appended after allowlist: auth*, *token*, *secret*, *.db*, sessions/, blobs/, etc.       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 2: Repository-Local .git/info/exclude                                                               │
│   Secondary un-committable layer applying the hard denylist even if .gitignore is modified.             │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 3: Pre-Commit Staging Blocker (`stagedSecretFiles`)                                                 │
│   Executes `git diff --cached --name-only -z` and tests every file against `isDenied()`.                 │
│   If any sensitive file is staged (e.g. via `git add -f`), it executes `git reset` and hard-aborts.     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Tier 4: Tracked Secrets Scanner (`trackedSecretFiles`)                                                   │
│   Inspects `git ls-files -z` during status and sync to detect historical or accidental commits.         │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
omp-config-sync/
├── package.json                   # Package manifest with @oh-my-pi/pi-coding-agent peerDep
├── tsconfig.json                  # TypeScript 5+ configuration (ESM, strict)
├── README.md                      # Documentation and usage guide
├── src/
│   ├── index.ts                   # Extension entrypoint, command registrations, lifecycle hooks
│   ├── config.ts                  # Configuration loading (omp-sync.jsonc/git-sync.jsonc), dirOf, paths
│   ├── security.ts                # 4-tier security guards, isDenied, allowlist/denylist rules
│   ├── filter.ts                  # Git clean/smudge filter configuration & filter.mjs generation
│   ├── lock.ts                    # PID-liveness file locking, subagent checks, auto-sync rate limiting
│   ├── git.ts                     # Low-level Git operations, ceiling directories, process execution
│   ├── gh.ts                      # GitHub CLI integration (auth, repo discovery, private creation)
│   └── sync.ts                    # High-level orchestrators: init, link, status, sync, push, pull
└── test/
    ├── helpers.ts                 # Test fixture setup, temporary repositories, fake GitHub client
    ├── security.test.ts           # Denylist, allowlist, and staging guard tests
    ├── filter.test.ts             # Clean/smudge filter for YAML & JSON tests
    ├── lock.test.ts               # Concurrency lock and auto-sync rate-limiting tests
    ├── git-ops.test.ts            # Git operations, integration, rebase abort tests
    └── end-to-end.test.ts         # Multi-machine round-trip sync tests
```

---

## Implementation Tasks

### Task 1: Project Scaffolding & TypeScript Configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `test/helpers.ts`

**Interfaces:**
- Consumes: Node.js standard libraries (`node:fs/promises`, `node:path`, `node:os`, `node:child_process`)
- Produces: Base test infrastructure and TypeScript project layout

- [ ] **Step 1: Write the failing test for test helper utilities**

```typescript
// test/helpers.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMachineFixture, createBareRemote, createFakeGh } from "./helpers.ts";

test("helpers create valid temporary machine directories and bare remotes", async () => {
  const machine = await createMachineFixture("test-machine");
  assert.ok(machine.dir.includes("test-machine"));
  assert.ok(await fs.stat(path.join(machine.dir, "config.yml")));
  assert.ok(await fs.stat(path.join(machine.dir, "AGENTS.md")));

  const remote = await createBareRemote(machine.root, "origin.git");
  assert.ok(await fs.stat(remote));

  const gh = createFakeGh();
  assert.equal(await gh.available(), true);
  assert.equal(await gh.currentUser(), "omp-tester");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/helpers.test.ts`
Expected: FAIL (Cannot find module `./helpers.ts`)

- [ ] **Step 3: Implement `package.json`, `tsconfig.json`, and `test/helpers.ts`**

```json
// package.json
{
  "name": "omp-config-sync",
  "version": "0.1.0",
  "description": "Securely sync your ~/.omp/agent configuration across machines through a private git repo with hard secret guards.",
  "type": "module",
  "license": "MIT",
  "keywords": [
    "omp-package",
    "omp-plugin",
    "pi-package"
  ],
  "files": [
    "dist",
    "src"
  ],
  "main": "./dist/index.js",
  "omp": {
    "extensions": [
      "./dist/index.js"
    ]
  },
  "pi": {
    "extensions": [
      "./dist/index.js"
    ]
  },
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "*",
    "@types/node": "^22",
    "typescript": "^5.7"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "tsc && node --test dist/test/*.test.js",
    "check": "npm run typecheck && npm test"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "test/**/*"]
}
```

```typescript
// test/helpers.ts
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GhClient } from "../src/gh.ts";

const exec = promisify(execFileCb);

export async function sh(cmd: string, args: string[], cwd?: string) {
  return exec(cmd, args, { cwd });
}

export interface MachineFixture {
  root: string;
  dir: string;
}

export async function createMachineFixture(name: string): Promise<MachineFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-sync-test-${name}-`));
  const dir = path.join(root, "agent");
  await fs.mkdir(path.join(dir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(dir, "skills"), { recursive: true });
  await fs.mkdir(path.join(dir, "agents"), { recursive: true });
  await fs.writeFile(path.join(dir, "config.yml"), `theme:\n  dark: titanium\nsetupVersion: 2\n`);
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agent Instructions\n");
  await fs.writeFile(path.join(dir, "extensions", "custom.ts"), "export default function() {}\n");
  await fs.writeFile(path.join(dir, "auth.json"), `secret-key-${name}`);
  return { root, dir };
}

export async function createBareRemote(root: string, name = "origin.git"): Promise<string> {
  const repo = path.join(root, name);
  await sh("git", ["init", "--bare", "-b", "main", repo]);
  return repo;
}

export function createFakeGh(overrides: Partial<GhClient> = {}): GhClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async available() {
      calls.push("available");
      return true;
    },
    async currentUser() {
      calls.push("currentUser");
      return "omp-tester";
    },
    async repoExists(id: string) {
      calls.push(`exists:${id}`);
      return false;
    },
    async isPrivate(id: string) {
      calls.push(`isPrivate:${id}`);
      return true;
    },
    async createPrivateRepo(id: string) {
      calls.push(`create:${id}`);
    },
    remoteUrl(id: string) {
      return `https://github.com/${id}.git`;
    },
    ...overrides,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/helpers.test.js`
Expected: PASS

- [ ] **Step 5: Commit scaffolding**

```bash
git add package.json tsconfig.json test/helpers.ts test/helpers.test.ts
git commit -m "chore: scaffold omp-config-sync package and test helpers"
```

---

### Task 2: Path Resolution, Profile Detection, and Configuration

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `process.env.OMP_PROFILE`, `process.env.PI_CODING_AGENT_DIR`
- Produces:
  - `dirOf(deps?: { dir?: string }): string`
  - `readConfig(deps?: Deps, ctx?: Ctx): Promise<GitSyncConfig>`
  - `stripJsonComments(input: string): string`
  - `interface GitSyncConfig`

- [ ] **Step 1: Write the failing test for configuration and path resolution**

```typescript
// test/config.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dirOf, readConfig, stripJsonComments } from "../src/config.ts";

test("dirOf resolves ~/.omp/agent by default, respects OMP_PROFILE and PI_CODING_AGENT_DIR", () => {
  const originalProfile = process.env.OMP_PROFILE;
  const originalPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.OMP_PROFILE;
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(dirOf(), path.join(os.homedir(), ".omp", "agent"));

    process.env.OMP_PROFILE = "work";
    assert.equal(dirOf(), path.join(os.homedir(), ".omp", "profiles", "work", "agent"));

    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    assert.equal(dirOf(), path.join(os.homedir(), "custom-agent"));

    assert.equal(dirOf({ dir: "/explicit/dir" }), "/explicit/dir");
  } finally {
    if (originalProfile) process.env.OMP_PROFILE = originalProfile; else delete process.env.OMP_PROFILE;
    if (originalPiDir) process.env.PI_CODING_AGENT_DIR = originalPiDir; else delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("readConfig parses JSONC with comments and validates safe extraPaths and machineLocalSettings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-test-"));
  const configContent = `{\n  // Auto sync interval in minutes\n  "autoSyncIntervalMinutes": 10,\n  "includeHostname": false,\n  "extraPaths": ["safe-dir", "custom/path", "../unsafe", "auth-token"],\n  "machineLocalSettings": ["setupVersion", "dev.autoqaConsent", ""]\n}`;
  await fs.writeFile(path.join(tempDir, "omp-sync.jsonc"), configContent);

  const config = await readConfig({ dir: tempDir });
  assert.equal(config.autoSyncIntervalMinutes, 10);
  assert.equal(config.includeHostname, false);
  assert.deepEqual(config.extraPaths, ["safe-dir", "custom/path"]);
  assert.deepEqual(config.machineLocalSettings, ["setupVersion", "dev.autoqaConsent"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/config.test.js`
Expected: FAIL (Cannot find module `../src/config.ts`)

- [ ] **Step 3: Implement `src/config.ts`**

```typescript
// src/config.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDenied } from "./security.ts";

export interface GitSyncConfig {
  autoSyncIntervalMinutes?: number;
  includeHostname?: boolean;
  extraPaths?: string[];
  warnOnPublicRemote?: boolean;
  machineLocalSettings?: string[];
  machineLocalYamlKeys?: string[];
}

export type Level = "info" | "warning" | "error";

export interface Deps {
  dir?: string;
  gh?: import("./gh.ts").GhClient;
  notify?: (message: string, level: Level) => void;
}

export interface UIContext {
  hasUI: boolean;
  ui: {
    setStatus(key: string, status?: string): void;
    notify(message: string, level: Level): void;
  };
}

export type Ctx = UIContext | undefined;

export const DEFAULT_MACHINE_LOCAL_JSON = ["lastChangelogVersion", "setupVersion"];
export const DEFAULT_MACHINE_LOCAL_YAML = [
  "setupVersion",
  "shellPath",
  "dev.autoqaPush.token",
  "dev.autoqaConsent",
  "searxng.token",
  "searxng.basicUsername",
  "searxng.basicPassword",
  "hindsight.apiToken",
  "hindsight.apiUrl",
  "auth.broker.url",
  "auth.broker.token",
  "images.urls.credentials",
  "images.urls.command",
  "python.interpreter",
  "ruby.interpreter",
  "julia.interpreter",
  "browser.cdpUrl",
  "browser.relayUrl",
];

export function dirOf(deps?: Deps): string {
  if (deps?.dir) return path.resolve(deps.dir);
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) {
    return explicit === "~" || explicit.startsWith("~/")
      ? path.join(os.homedir(), explicit.slice(2))
      : path.resolve(explicit);
  }
  const profile = process.env.OMP_PROFILE?.trim();
  if (profile) {
    return path.join(os.homedir(), ".omp", "profiles", profile, "agent");
  }
  return path.join(os.homedir(), ".omp", "agent");
}

export function stripJsonComments(input: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = input[i + 1];
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

export function isValidExtraPath(entry: string): boolean {
  return entry.trim() !== "" && !entry.includes("..") && !path.isAbsolute(entry) && !isDenied(entry);
}

export async function readConfigFile(dir: string): Promise<string | undefined> {
  for (const filename of ["omp-sync.jsonc", "omp-sync.json", "git-sync.jsonc", "git-sync.json"]) {
    try {
      return await fs.readFile(path.join(dir, filename), "utf8");
    } catch {}
  }
  return undefined;
}

export async function readConfig(deps?: Deps, ctx?: Ctx): Promise<GitSyncConfig> {
  const dir = dirOf(deps);
  const rawText = await readConfigFile(dir);
  if (!rawText) return {};

  try {
    const raw = JSON.parse(stripJsonComments(rawText)) as GitSyncConfig;
    const extras = (raw.extraPaths ?? []).filter(isValidExtraPath);

    let machineLocalSettings: string[] | undefined;
    if (Array.isArray(raw.machineLocalSettings)) {
      machineLocalSettings = raw.machineLocalSettings.filter(
        (key): key is string => typeof key === "string" && key.trim() !== ""
      );
    }

    let machineLocalYamlKeys: string[] | undefined;
    if (Array.isArray(raw.machineLocalYamlKeys)) {
      machineLocalYamlKeys = raw.machineLocalYamlKeys.filter(
        (key): key is string => typeof key === "string" && key.trim() !== ""
      );
    }

    return {
      ...raw,
      extraPaths: extras,
      machineLocalSettings,
      machineLocalYamlKeys,
    };
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit configuration module**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): implement path resolution and jsonc config parser"
```

---

### Task 3: Security Guardrails, Allowlists, and Managed Git Ignore Rules

**Files:**
- Create: `src/security.ts`
- Test: `test/security.test.ts`

**Interfaces:**
- Consumes: `src/config.ts`
- Produces:
  - `isDenied(file: string): boolean`
  - `ensureIgnoreRules(dir: string, config?: GitSyncConfig): Promise<void>`
  - `ensureInfoExclude(dir: string): Promise<void>`
  - `stagedSecretFiles(dir: string): Promise<string[]>`
  - `trackedSecretFiles(dir: string): Promise<string[]>`

- [ ] **Step 1: Write the failing test for security rules and staging guards**

```typescript
// test/security.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDenied, ensureIgnoreRules, ensureInfoExclude, stagedSecretFiles, trackedSecretFiles } from "../src/security.ts";
import { sh } from "./helpers.ts";

test("isDenied blocks all secrets, databases, runtime state, and local credentials", () => {
  const blocked = [
    "auth.json", "auth-broker.json", "api_key.txt", "token.secret",
    "agent.db", "models.db-wal", "history.db-shm", "state.sqlite",
    "sessions/abc/session.jsonl", "blobs/123", "terminal-sessions/pts-1",
    "natives/18.0.10", "logs/omp.log", "run/daemons/pid.json", "wt/feature-branch",
    "cache/composer/welcome.json", "last-changelog-version",
    ".env", "prod.env", "config.local.yml", "mcp.local.json", "node_modules/pkg/index.js"
  ];
  for (const file of blocked) {
    assert.ok(isDenied(file), `Expected denied: ${file}`);
  }

  const allowed = [
    "config.yml", "mcp.json", "settings.json", "AGENTS.md", "Agents.md",
    "omp-sync.jsonc", ".gitignore", ".gitattributes",
    "extensions/tps.ts", "skills/review.md", "agents/scout.json",
    "themes/titanium.json", "prompts/code.md", "chains/ci.md"
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/security.test.js`
Expected: FAIL (Cannot find module `../src/security.ts`)

- [ ] **Step 3: Implement `src/security.ts`**

```typescript
// src/security.ts
import fs from "node:fs/promises";
import path from "node:path";
import { type GitSyncConfig, isValidExtraPath } from "./config.ts";
import { git } from "./git.ts";

export const START_MARKER = "# >>> omp-config-sync managed — do not edit inside this block";
export const END_MARKER = "# <<< omp-config-sync managed";
export const LEGACY_MARKERS: Array<[string, string]> = [
  ["# >>> pi-config-sync managed — do not edit inside this block", "# <<< pi-config-sync managed"],
  ["# >>> pi-git-sync managed — do not edit inside this block", "# <<< pi-git-sync managed"],
];

export const DEFAULT_ALLOWED_PATHS = [
  ".gitignore",
  ".gitattributes",
  "config.yml",
  "config.yaml",
  "mcp.json",
  "settings.json",
  "AGENTS.md",
  "Agents.md",
  "omp-sync.jsonc",
  "omp-sync.json",
  "git-sync.jsonc",
  "git-sync.json",
  "extensions",
  "skills",
  "agents",
  "chains",
  "prompts",
  "themes",
  "plugins",
];

export const HARD_DENY_PATTERNS = [
  "auth*",
  "*token*",
  "*secret*",
  "*credential*",
  "*.env",
  "*.env.*",
  "*.local.json",
  "*.local.yml",
  "*.local.yaml",
  "*.db",
  "*.db-*",
  "*.sqlite",
  "*.sqlite3",
  "sessions/",
  "state/",
  "blobs/",
  "terminal-sessions/",
  "cache/",
  "natives/",
  "logs/",
  "run/",
  "wt/",
  ".git-sync/",
  "last-changelog-version",
  "**/node_modules/",
  ".DS_Store",
];

export function isDenied(file: string): boolean {
  const normalized = file.toLowerCase().replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "";

  const deniedSegments = [
    "sessions",
    "state",
    "blobs",
    "terminal-sessions",
    "cache",
    "natives",
    "logs",
    "run",
    "wt",
    ".git-sync",
    "node_modules",
    "npm",
    "git",
    "bin",
  ];

  if (parts.some((p) => deniedSegments.includes(p))) return true;

  if (
    basename.startsWith("auth") ||
    basename.includes("token") ||
    basename.includes("secret") ||
    basename.includes("credential") ||
    basename === ".env" ||
    basename.includes(".env.") ||
    basename.endsWith(".env") ||
    basename.endsWith(".local.json") ||
    basename.endsWith(".local.yml") ||
    basename.endsWith(".local.yaml") ||
    basename === "last-changelog-version" ||
    basename.endsWith(".db") ||
    basename.includes(".db-") ||
    basename.endsWith(".sqlite") ||
    basename.endsWith(".sqlite3")
  ) {
    return true;
  }

  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allowRules(entry: string): string[] {
  const segments = entry.replace(/\/+$/, "").split("/").filter(Boolean);
  const rules: string[] = [];
  let prefix = "";
  for (let i = 0; i < segments.length; i++) {
    prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!;
    if (i < segments.length - 1) {
      rules.push(`!${prefix}/`);
    } else {
      rules.push(`!${prefix}`, `!${prefix}/`, `!${prefix}/**`);
    }
  }
  return rules;
}

export async function ensureIgnoreRules(dir: string, config: GitSyncConfig = {}): Promise<void> {
  const file = path.join(dir, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {}

  const paths = [...DEFAULT_ALLOWED_PATHS, ...(config.extraPaths ?? []).filter(isValidExtraPath)];
  const lines = [
    START_MARKER,
    "*",
    ...paths.flatMap(allowRules),
    "# hard denylist — re-ignored even inside allowed directories",
    ...HARD_DENY_PATTERNS,
    END_MARKER,
  ];
  const block = lines.join("\n");

  let base = existing;
  for (const [start, end] of [[START_MARKER, END_MARKER] as [string, string], ...LEGACY_MARKERS]) {
    const re = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
    base = base.replace(re, "");
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, (base.trim() ? `${base.trim()}\n\n` : "") + block + "\n");
}

export async function ensureInfoExclude(dir: string): Promise<void> {
  const file = path.join(dir, ".git", "info", "exclude");
  await fs.mkdir(path.dirname(file), { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {}

  const existingRules = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = HARD_DENY_PATTERNS.filter((rule) => !existingRules.has(rule));

  if (missing.length) {
    const nextContent = (current.trim() ? `${current.trim()}\n` : "") + missing.join("\n") + "\n";
    await fs.writeFile(file, nextContent);
  }
}

export async function stagedSecretFiles(dir: string): Promise<string[]> {
  const { stdout } = await git(["diff", "--cached", "--name-only", "-z"], dir);
  return stdout.split("\0").filter(Boolean).filter(isDenied);
}

export async function trackedSecretFiles(dir: string): Promise<string[]> {
  try {
    const { stdout } = await git(["ls-files", "-z"], dir);
    return stdout.split("\0").filter(Boolean).filter(isDenied);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/security.test.js`
Expected: PASS

- [ ] **Step 5: Commit security module**

```bash
git add src/security.ts test/security.test.ts
git commit -m "feat(security): implement 4-tier security guards and deny rules"
```

---

### Task 4: Dual YAML & JSON Clean/Smudge Filter and Machine Sidecars

**Files:**
- Create: `src/filter.ts`
- Test: `test/filter.test.ts`

**Interfaces:**
- Consumes: `src/config.ts`, `src/git.ts`
- Produces:
  - `ensureFilter(dir: string, config?: GitSyncConfig): Promise<void>`
  - `ensureAttributes(dir: string): Promise<void>`
  - `refreshMachineSidecar(dir: string, config?: GitSyncConfig): Promise<void>`

- [ ] **Step 1: Write the failing test for clean/smudge filtering on YAML and JSON**

```typescript
// test/filter.test.ts
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ensureFilter, ensureAttributes, refreshMachineSidecar } from "../src/filter.ts";
import { sh } from "./helpers.ts";

const exec = promisify(execFileCb);

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/filter.test.js`
Expected: FAIL (Cannot find module `../src/filter.ts`)

- [ ] **Step 3: Implement `src/filter.ts`**

```typescript
// src/filter.ts
import fs from "node:fs/promises";
import path from "node:path";
import { type GitSyncConfig, DEFAULT_MACHINE_LOCAL_JSON, DEFAULT_MACHINE_LOCAL_YAML } from "./config.ts";
import { git, hasDotGit } from "./git.ts";

export function stateDir(dir: string): string {
  return path.join(dir, ".git-sync");
}

export function machineJsonKeys(config: GitSyncConfig): string[] {
  return config.machineLocalSettings ?? DEFAULT_MACHINE_LOCAL_JSON;
}

export function machineYamlKeys(config: GitSyncConfig): string[] {
  return config.machineLocalYamlKeys ?? DEFAULT_MACHINE_LOCAL_YAML;
}

export function generateFilterScript(jsonKeys: string[], yamlKeys: string[]): string {
  return `import fs from "node:fs";

const jsonKeys = ${JSON.stringify(jsonKeys)};
const yamlKeys = ${JSON.stringify(yamlKeys)};

const mode = process.argv[2];
const format = process.argv[3] || "json";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks);
const text = raw.toString("utf8");

function cleanYamlLine(line, keys) {
  const trimmed = line.trimStart();
  for (const key of keys) {
    const prefix = key + ":";
    if (trimmed.startsWith(prefix) && line.search(/\\S/) === 0) {
      return true;
    }
  }
  return false;
}

try {
  if (format === "yaml") {
    if (mode === "clean") {
      const lines = text.split(/\\r?\\n/);
      const filtered = [];
      let skippingBlock = false;
      let blockIndent = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const indent = line.search(/\\S/);

        if (skippingBlock) {
          if (indent > blockIndent && line.trim() !== "") {
            continue;
          } else {
            skippingBlock = false;
          }
        }

        if (cleanYamlLine(line, yamlKeys)) {
          skippingBlock = true;
          blockIndent = indent >= 0 ? indent : 0;
          continue;
        }

        filtered.push(line);
      }
      process.stdout.write(filtered.join("\\n"));
    } else if (mode === "smudge") {
      const sidecarPath = new URL("config.machine.yml", import.meta.url);
      let sidecarText = "";
      try {
        sidecarText = fs.readFileSync(sidecarPath, "utf8");
      } catch {}
      const combined = (text.trim() ? text.trim() + "\\n" : "") + sidecarText.trim() + (sidecarText.trim() ? "\\n" : "");
      process.stdout.write(combined);
    } else {
      process.stdout.write(raw);
    }
  } else {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not object");

    if (mode === "clean") {
      for (const key of jsonKeys) delete value[key];
      process.stdout.write(JSON.stringify(value, null, 2) + "\\n");
    } else if (mode === "smudge") {
      const sidecarPath = new URL("settings.machine.json", import.meta.url);
      let sidecar = {};
      try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      } catch {}
      process.stdout.write(JSON.stringify({ ...value, ...sidecar }, null, 2) + "\\n");
    } else {
      process.stdout.write(raw);
    }
  }
} catch {
  process.stdout.write(raw);
}
`;
}

export async function ensureAttributes(dir: string): Promise<void> {
  const file = path.join(dir, ".gitattributes");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {}

  const rules = [
    "config.yml filter=omp-config-sync-yaml",
    "config.yaml filter=omp-config-sync-yaml",
    "settings.json filter=omp-config-sync-json",
    "mcp.json filter=omp-config-sync-json",
  ];

  const existing = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = rules.filter((r) => !existing.has(r));

  if (missing.length) {
    const next = (current.trim() ? `${current.trim()}\n` : "") + missing.join("\n") + "\n";
    await fs.writeFile(file, next);
  }
}

async function gitConfigValue(key: string, dir: string): Promise<string | undefined> {
  try {
    return (await git(["config", "--get", key], dir)).stdout.trim();
  } catch {
    return undefined;
  }
}

export async function ensureFilter(dir: string, config: GitSyncConfig = {}): Promise<void> {
  if (!(await hasDotGit(dir))) return;

  await fs.mkdir(stateDir(dir), { recursive: true });
  const scriptPath = path.join(stateDir(dir), "filter.mjs");
  const source = generateFilterScript(machineJsonKeys(config), machineYamlKeys(config));

  try {
    if ((await fs.readFile(scriptPath, "utf8")) !== source) {
      await fs.writeFile(scriptPath, source);
    }
  } catch {
    await fs.writeFile(scriptPath, source);
  }

  const quote = (val: string) => `'${val.replaceAll("'", "'\\''")}'`;
  const nodeExec = quote(process.execPath);
  const scriptArg = quote(scriptPath);

  const configs: Record<string, string> = {
    "filter.omp-config-sync-yaml.clean": `${nodeExec} ${scriptArg} clean yaml`,
    "filter.omp-config-sync-yaml.smudge": `${nodeExec} ${scriptArg} smudge yaml`,
    "filter.omp-config-sync-yaml.required": "false",
    "filter.omp-config-sync-json.clean": `${nodeExec} ${scriptArg} clean json`,
    "filter.omp-config-sync-json.smudge": `${nodeExec} ${scriptArg} smudge json`,
    "filter.omp-config-sync-json.required": "false",
  };

  let changed = false;
  for (const [k, v] of Object.entries(configs)) {
    if ((await gitConfigValue(k, dir)) !== v) {
      await git(["config", k, v], dir);
      changed = true;
    }
  }

  if (changed) {
    try {
      await git(["add", "--renormalize", "config.yml", "settings.json", "mcp.json"], dir);
    } catch {}
  }
}

export async function refreshMachineSidecar(dir: string, config: GitSyncConfig = {}): Promise<void> {
  await fs.mkdir(stateDir(dir), { recursive: true });

  // 1. JSON sidecar
  try {
    const raw = await fs.readFile(path.join(dir, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      const keys = machineJsonKeys(config);
      const sidecar = Object.fromEntries(keys.filter((k) => Object.hasOwn(settings, k)).map((k) => [k, settings[k]]));
      await fs.writeFile(path.join(stateDir(dir), "settings.machine.json"), JSON.stringify(sidecar, null, 2) + "\n");
    }
  } catch {}

  // 2. YAML sidecar
  try {
    const raw = await fs.readFile(path.join(dir, "config.yml"), "utf8");
    const keys = new Set(machineYamlKeys(config));
    const lines = raw.split(/\r?\n/);
    const extracted: string[] = [];
    let capturing = false;
    let captureIndent = 0;

    for (const line of lines) {
      const indent = line.search(/\S/);
      if (capturing) {
        if (indent > captureIndent && line.trim() !== "") {
          extracted.push(line);
          continue;
        } else {
          capturing = false;
        }
      }
      const trimmed = line.trimStart();
      for (const key of keys) {
        if (trimmed.startsWith(`${key}:`) && indent === 0) {
          capturing = true;
          captureIndent = indent;
          extracted.push(line);
          break;
        }
      }
    }

    if (extracted.length) {
      await fs.writeFile(path.join(stateDir(dir), "config.machine.yml"), extracted.join("\n") + "\n");
    }
  } catch {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/filter.test.js`
Expected: PASS

- [ ] **Step 5: Commit filter module**

```bash
git add src/filter.ts test/filter.test.ts
git commit -m "feat(filter): implement dual YAML and JSON clean/smudge git filter"
```

---

### Task 5: Concurrency Lock, Subagent Isolation, and Auto-Sync Evaluation

**Files:**
- Create: `src/lock.ts`
- Test: `test/lock.test.ts`

**Interfaces:**
- Consumes: `src/config.ts`, `src/git.ts`
- Produces:
  - `withLock<T>(ctx: Ctx, fn: () => Promise<T>, deps?: Deps): Promise<T | undefined>`
  - `isSubagentChild(): boolean`
  - `shouldAutoSync(deps?: Deps): Promise<boolean>`
  - `writeSyncState(state: { lastAutoSyncAt: string }, dir?: string): Promise<void>`

- [ ] **Step 1: Write the failing test for concurrency locking and subagent detection**

```typescript
// test/lock.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withLock, isSubagentChild, shouldAutoSync, writeSyncState } from "../src/lock.ts";
import { sh } from "./helpers.ts";

test("isSubagentChild detects subagent environment variables", () => {
  delete process.env.PI_SUBAGENT_DEPTH;
  delete process.env.OMP_SUBAGENT_DEPTH;
  delete process.env.OMP_IS_SUBAGENT;
  assert.equal(isSubagentChild(), false);

  process.env.OMP_SUBAGENT_DEPTH = "1";
  assert.equal(isSubagentChild(), true);

  delete process.env.OMP_SUBAGENT_DEPTH;
  process.env.OMP_IS_SUBAGENT = "true";
  assert.equal(isSubagentChild(), true);

  delete process.env.OMP_IS_SUBAGENT;
});

test("withLock handles live process concurrency and stale locks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lock-test-"));
  const deps = { dir: root };

  const result1 = await withLock(undefined, async () => "executed-1", deps);
  assert.equal(result1, "executed-1");

  // Lock file should be removed on completion
  const lockFile = path.join(root, ".git-sync", "lock");
  assert.rejects(async () => fs.stat(lockFile));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/lock.test.js`
Expected: FAIL (Cannot find module `../src/lock.ts`)

- [ ] **Step 3: Implement `src/lock.ts`**

```typescript
// src/lock.ts
import fs from "node:fs/promises";
import path from "node:path";
import { type Ctx, type Deps, dirOf, readConfig } from "./config.ts";
import { isSyncableRepo } from "./git.ts";

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
    return JSON.parse(await fs.readFile(statePath(dir), "utf8")) as { lastAutoSyncAt?: string };
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
      const lockData = JSON.parse(await fs.readFile(lock, "utf8")) as { pid: number; startedAt: string };
      if (Number.isInteger(lockData.pid) && lockData.pid > 0) {
        process.kill(lockData.pid, 0);
        // If owner process is alive and lock is less than 10 minutes old, skip execution
        if (Date.now() - Date.parse(lockData.startedAt) < 600_000) {
          return undefined;
        }
      }
    } catch {}
    // Lock owner is dead or invalid; clean up stale lock and retry once
    await fs.rm(lock, { force: true });
    return withLock(ctx, fn, deps);
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/lock.test.js`
Expected: PASS

- [ ] **Step 5: Commit lock module**

```bash
git add src/lock.ts test/lock.test.ts
git commit -m "feat(lock): implement concurrency locking and subagent isolation"
```

---

### Task 6: Git Engine & GitHub CLI Operations

**Files:**
- Create: `src/git.ts`
- Create: `src/gh.ts`
- Test: `test/git-ops.test.ts`

**Interfaces:**
- Consumes: Node.js `child_process`
- Produces:
  - `git(args: string[], dir: string, timeout?: number): Promise<{ stdout: string; stderr: string }>`
  - `gitRaw(args: string[], dir: string): Promise<{ stdout: Buffer; stderr: Buffer }>`
  - `GhClient` interface & `defaultGh` implementation
  - `parseRepoReference(input: string, fallbackOwner: string)`

- [ ] **Step 1: Write failing test for Git and GitHub CLI helpers**

```typescript
// test/git-ops.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, hasDotGit, isSyncableRepo, upstreamRef } from "../src/git.ts";
import { parseRepoReference } from "../src/gh.ts";
import { sh } from "./helpers.ts";

test("parseRepoReference parses various GitHub repository URL and name shapes", () => {
  assert.deepEqual(parseRepoReference("my-config", "user1"), { owner: "user1", name: "my-config" });
  assert.deepEqual(parseRepoReference("org/repo", "user1"), { owner: "org", name: "repo" });
  assert.deepEqual(parseRepoReference("git@github.com:org/repo.git", "user1"), { owner: "org", name: "repo" });
  assert.deepEqual(parseRepoReference("https://github.com/org/repo", "user1"), { owner: "org", name: "repo" });
});

test("git operations execute in isolated ceiling directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-test-"));
  assert.equal(await hasDotGit(root), false);
  await git(["init", "-b", "main"], root);
  assert.equal(await hasDotGit(root), true);
  assert.equal(await isSyncableRepo(root), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/git-ops.test.js`
Expected: FAIL (Cannot find module `../src/git.ts`)

- [ ] **Step 3: Implement `src/git.ts` and `src/gh.ts`**

```typescript
// src/git.ts
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dirOf } from "./config.ts";

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
```

```typescript
// src/gh.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GhClient {
  available(): Promise<boolean>;
  currentUser(): Promise<string>;
  repoExists(id: string): Promise<boolean>;
  isPrivate(id: string): Promise<boolean | undefined>;
  createPrivateRepo(id: string): Promise<void>;
  remoteUrl(id: string): string;
}

export const LIKELY_SYNC_REPO_NAMES = [
  "omp-agent-config",
  "my-omp-config",
  "omp-config",
  "dotfiles-omp",
  "pi-agent-config",
];

export function parseRepoReference(input: string, fallbackOwner: string): { owner: string; name: string } | undefined {
  const raw = input.trim().replace(/\.git$/i, "");
  if (!raw) return undefined;

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };

  try {
    const url = new URL(raw);
    if (["github.com", "www.github.com"].includes(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 2) {
        return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/i, "") };
      }
    }
  } catch {}

  const bits = raw.split("/").filter(Boolean);
  if (bits.length === 1) return { owner: fallbackOwner, name: bits[0]! };
  if (bits.length === 2 && !raw.includes(":")) return { owner: bits[0]!, name: bits[1]! };

  return undefined;
}

export function remoteFromArg(arg: string, fallbackOwner: string): string | undefined {
  if (/^(https?|ssh):\/\//.test(arg) || /^git@/.test(arg) || arg.startsWith("/") || arg.startsWith(".")) {
    return arg;
  }
  const ref = parseRepoReference(arg, fallbackOwner);
  return ref ? `https://github.com/${ref.owner}/${ref.name}.git` : undefined;
}

export const defaultGh: GhClient = {
  async available() {
    try {
      await exec("gh", ["auth", "status"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },
  async currentUser() {
    return (await exec("gh", ["api", "user", "--jq", ".login"])).stdout.trim();
  },
  async repoExists(id: string) {
    try {
      await exec("gh", ["repo", "view", id, "--json", "name"]);
      return true;
    } catch {
      return false;
    }
  },
  async isPrivate(id: string) {
    try {
      const { stdout } = await exec("gh", ["repo", "view", id, "--json", "isPrivate"]);
      return (JSON.parse(stdout) as { isPrivate: boolean }).isPrivate;
    } catch {
      return undefined;
    }
  },
  async createPrivateRepo(id: string) {
    await exec("gh", ["repo", "create", id, "--private"], { timeout: 15_000 });
  },
  remoteUrl(id: string) {
    return `https://github.com/${id}.git`;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/git-ops.test.js`
Expected: PASS

- [ ] **Step 5: Commit git and github modules**

```bash
git add src/git.ts src/gh.ts test/git-ops.test.ts
git commit -m "feat(git): implement git operations and gh client"
```

---

### Task 7: Core Workflow Orchestrators (Init, Link, Status, Sync)

**Files:**
- Create: `src/sync.ts`
- Test: `test/end-to-end.test.ts`

**Interfaces:**
- Consumes: `src/config.ts`, `src/security.ts`, `src/filter.ts`, `src/lock.ts`, `src/git.ts`, `src/gh.ts`
- Produces:
  - `runInit(arg: string, ctx?: Ctx, deps?: Deps): Promise<void>`
  - `runLink(arg: string, ctx?: Ctx, deps?: Deps): Promise<void>`
  - `showStatus(ctx: Ctx, deps?: Deps): Promise<void>`
  - `runSync(ctx: Ctx, options: { auto: boolean; push: boolean; skipPull?: boolean }, deps?: Deps): Promise<void>`
  - `commitLocalChanges(deps?: Deps, commitMessage?: string, ctx?: Ctx): Promise<boolean>`

- [ ] **Step 1: Write failing test for complete multi-machine round-trip sync**

```typescript
// test/end-to-end.test.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runInit, runLink, runSync } from "../src/sync.ts";
import { createMachineFixture, createBareRemote, createFakeGh } from "./helpers.ts";

test("end-to-end round trip: init machine A, link machine B, sync bidirectional changes", async () => {
  const a = await createMachineFixture("machine-a");
  const remote = await createBareRemote(a.root);
  const ghA = createFakeGh();

  // 1. Init on Machine A
  await runInit(remote, undefined, { dir: a.dir, gh: ghA });

  // 2. Link on Machine B
  const b = await createMachineFixture("machine-b");
  await fs.writeFile(path.join(b.dir, "config.yml"), "theme:\n  dark: custom-b\n");
  const ghB = createFakeGh();
  await runLink(remote, undefined, { dir: b.dir, gh: ghB });

  // Local differing file moved to .local-backup
  assert.ok(await fs.stat(path.join(b.dir, "config.yml.local-backup")));
  assert.equal(await fs.readFile(path.join(b.dir, "auth.json"), "utf8"), "secret-key-machine-b");

  // 3. Make change on Machine B and sync
  await fs.writeFile(path.join(b.dir, "AGENTS.md"), "# Updated on B\n");
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });

  // 4. Sync Machine A and verify change received
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });
  assert.equal(await fs.readFile(path.join(a.dir, "AGENTS.md"), "utf8"), "# Updated on B\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/end-to-end.test.js`
Expected: FAIL (Cannot find module `../src/sync.ts`)

- [ ] **Step 3: Implement `src/sync.ts`**

```typescript
// src/sync.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Ctx, type Deps, dirOf, readConfig } from "./config.ts";
import { ensureAttributes, ensureFilter, refreshMachineSidecar } from "./filter.ts";
import { defaultGh, LIKELY_SYNC_REPO_NAMES, parseRepoReference, remoteFromArg } from "./gh.ts";
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
} from "./git.ts";
import {
  ensureIgnoreRules,
  ensureInfoExclude,
  isDenied,
  stagedSecretFiles,
  trackedSecretFiles,
} from "./security.ts";

const STATUS_KEY = "omp-git-sync";

function notify(ctx: Ctx, message: string, level: "info" | "warning" | "error", deps?: Deps) {
  if (deps?.notify) {
    deps.notify(message, level);
  } else if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
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

export async function runInit(arg: string, ctx?: Ctx, deps?: Deps): Promise<void> {
  const dir = dirOf(deps);
  await fs.mkdir(dir, { recursive: true });
  if (await isSyncableRepo(dir)) {
    throw new Error("already initialized; use /ompsync sync");
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
    const ref = parseRepoReference(arg || "omp-agent-config", owner);
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

  notify(ctx, "omp-sync: initialized and pushed private config repo.", "info", deps);
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

export async function runLink(arg: string, ctx?: Ctx, deps?: Deps): Promise<void> {
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

  await git(["checkout", "-B", branch, `origin/${branch}`], dir);

  const tracked = await trackedSecretFiles(dir);
  if (tracked.length) {
    notify(ctx, `omp-sync: remote tracks sensitive files: ${tracked.join(", ")}. Remove with git rm --cached <file>.`, "warning", deps);
  }

  notify(
    ctx,
    `omp-sync: linked — run /reload to apply pulled config.${backups.length ? ` Backed up: ${backups.join(", ")}.` : ""}`,
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

  notify(
    ctx,
    `repo: ${dir}\nbranch: ${branch}\nuncommitted changes: ${dirty ? "yes" : "none"}${bad.length ? `\nWARNING tracked sensitive files: ${bad.join(", ")}` : ""}`,
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

  if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, "syncing");

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
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/end-to-end.test.js`
Expected: PASS

- [ ] **Step 5: Commit sync module**

```bash
git add src/sync.ts test/end-to-end.test.ts
git commit -m "feat(sync): implement core init, link, status, and sync workflows"
```

---

### Task 8: Extension Registration, Slash Commands, and Lifecycle Hooks

**Files:**
- Create: `src/index.ts`
- Test: `test/extension.test.ts`

**Interfaces:**
- Consumes: `@oh-my-pi/pi-coding-agent`, `src/sync.ts`, `src/lock.ts`
- Produces: Default export `gitSyncExtension(pi: ExtensionAPI): void`

- [ ] **Step 1: Write failing test for extension commands and lifecycle handlers**

```typescript
// test/extension.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import gitSyncExtension from "../src/index.ts";

test("extension registers /ompsync and /gitsync commands and session listeners", () => {
  const commands: Record<string, unknown> = {};
  const events: Record<string, Function[]> = {};

  const mockPi: Partial<ExtensionAPI> = {
    setLabel(label: string) {},
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/extension.test.js`
Expected: FAIL (Cannot find module `../src/index.ts`)

- [ ] **Step 3: Implement `src/index.ts`**

```typescript
// src/index.ts
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isSubagentChild, shouldAutoSync, withLock, writeSyncState } from "./lock.ts";
import { commitLocalChanges, prepareCommit, runInit, runLink, runSync, showStatus } from "./sync.ts";
import { isSyncableRepo, pushOrigin, upstreamRef, countAheadBehind } from "./git.ts";
import { dirOf } from "./config.ts";

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
    const reason = typeof event === "object" && event ? (event as { reason?: string }).reason : undefined;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/extension.test.js`
Expected: PASS

- [ ] **Step 5: Commit entrypoint module**

```bash
git add src/index.ts test/extension.test.ts
git commit -m "feat(extension): wire /ompsync commands and session lifecycle hooks"
```

---

### Task 9: Documentation, Installation Instructions, and Quality Verification

**Files:**
- Create: `README.md`
- Test: Full build and test run (`npm run check`)

**Interfaces:**
- Consumes: Completed implementation
- Produces: Production documentation and verified artifacts

- [ ] **Step 1: Write comprehensive `README.md`**

```markdown
# omp-config-sync

Securely sync your Oh My Pi (`~/.omp/agent`) configuration across machines through a private Git repository — automatically, with 4-tier guards keeping secrets and databases out.

## Installation

### Method 1: Oh My Pi Plugin CLI
```sh
omp plugin install omp-config-sync
```

### Method 2: Local Extension Link
```sh
omp plugin link /path/to/omp-config-sync
```

### Method 3: Direct Extension Placement
Place `dist/index.js` or symlink the project directory inside `~/.omp/agent/extensions/`.

## Quickstart

1. **First Machine:** Run `/ompsync init`. With GitHub CLI authenticated (`gh auth login`), it creates a private `omp-agent-config` repository, commits allowlisted files, and pushes them.
2. **Additional Machines:** Run `/ompsync link`. It pulls your configuration, safely backing up any differing local files with a `.local-backup` extension.
3. **Daily Usage:** Syncing is fully automatic on session start and shutdown. Run `/ompsync status` anytime to view synchronization state.
```

- [ ] **Step 2: Run full build and test verification**

Run: `npm run check`
Expected: All TypeScript typechecks and unit/integration tests PASS with zero errors.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: add comprehensive readme and installation guide"
```

---

## Self-Review Checklist

1. **Spec Coverage:**
   - [x] OMP agent path resolution (`~/.omp/agent`, `OMP_PROFILE`, `PI_CODING_AGENT_DIR`)
   - [x] Dual YAML (`config.yml`) and JSON (`settings.json`, `mcp.json`) clean/smudge filtering
   - [x] 4-Tier security model with OMP database exclusions (`*.db*`, `blobs/`, `sessions/`, `logs/`, `wt/`, etc.)
   - [x] Subagent depth isolation (`OMP_SUBAGENT_DEPTH`, `OMP_IS_SUBAGENT`, `PI_SUBAGENT_DEPTH`)
   - [x] Zero-touch GitHub CLI integration with OMP repository discovery
   - [x] Non-destructive conflict backups and rebase aborts
2. **Placeholder Scan:** Zero placeholders, `TODO`s, or unresolved symbols.
3. **Type Consistency:** Full TypeScript strict type definitions across all interfaces (`Deps`, `Ctx`, `GitSyncConfig`, `GhClient`).

---

## Execution Handoff

Plan complete and saved to `plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints

Which approach?
