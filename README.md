# omp-settings-sync

[![npm](https://img.shields.io/npm/v/omp-settings-sync)](https://www.npmjs.com/package/omp-settings-sync)
[![CI](https://github.com/aaxyat/omp-settings-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/aaxyat/omp-settings-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Securely sync your [Oh My Pi](https://omp.sh) (`~/.omp/agent`) configuration across machines through a private Git remote — automatically, with 4-tier guards keeping secrets, databases, and runtime state out.

The agent directory (`~/.omp/agent` or `~/.omp/profiles/<profile>/agent`) **is** the repository, ensuring transparent version history with zero shadow staging copies.

---

## Installation

### Method 1: Oh My Pi Plugin CLI
```sh
omp plugin install omp-settings-sync
```

Or from a specific npm tag/scoped package:
```sh
omp plugin install @aaxyat/omp-settings-sync@0.1.0
```

### Method 2: Link Local Clone
```sh
omp plugin link /path/to/omp-settings-sync
```

### Method 3: Direct Extension Placement
Place `dist/index.js` or symlink the project directory inside `~/.omp/agent/extensions/`.

---

## Quickstart

### 1. First Machine
Run:
```text
/ompsync init
```
With GitHub CLI authenticated (`gh auth login`), it detects your account, creates a private `omp-agent-config` repository, commits allowlisted files, and pushes them.

Without `gh`, create a private remote on GitHub or GitLab, then pass the URL:
```text
/ompsync init git@github.com:you/omp-agent-config.git
```

### 2. Additional Machines
Run:
```text
/ompsync link
```
(or `/ompsync link <remote-url>`).

It connects the remote repository. Any differing local allowed files are safely preserved as `<file>.local-backup`. Run `/reload` afterwards.

### 3. Daily Usage
Synchronization is fully automatic:
- **Session Start:** Checks rate limit (default every 5 minutes) and performs a background fetch, rebase, and push.
- **Session Shutdown:** Performs a fast best-effort commit and push.

---

## Commands

| Command | Description |
| :--- | :--- |
| `/ompsync init [url\|name]` | Initialize and push the first-machine private repository |
| `/ompsync link [url\|name]` | Link an existing sync repository on a new machine |
| `/ompsync status` | Display repository state, branch, and tracked sensitive files check |
| `/ompsync sync` | Commit, fetch, integrate remote changes (rebase), and push |
| `/ompsync push` | Commit and push local changes without pulling |
| `/ompsync pull` | Fetch and rebase remote updates |

*(Note: `/gitsync` is registered as a direct alias for backwards compatibility.)*

---

## Security Model

`omp-settings-sync` uses an **exclusive allowlist** architecture combined with **4 defensive tiers**:

### What Syncs (Allowlist)
- `config.yml` / `config.yaml`: Global model defaults, themes, tool parameters (with machine-local & sensitive keys stripped via git filter)
- `mcp.json`: Model Context Protocol server registrations
- `settings.json`: Legacy/migrated settings (with machine keys stripped)
- `AGENTS.md` / `Agents.md`: Global instructions and directives
- `extensions/`, `skills/`, `agents/`, `chains/`, `prompts/`, `themes/`, `plugins/`: Custom resources
- `.gitignore`, `.gitattributes`, `omp-sync.jsonc`: Sync policy

### What NEVER Syncs (Hard Denylist)
- `auth*` (`auth.json`, `auth-broker.json`): API keys and OAuth tokens
- `*token*`, `*secret*`, `*credential*`, `*.env*`, `*.local.json`, `*.local.yml`: Any file containing secrets
- `*.db`, `*.db-*`, `*.sqlite*` (`agent.db`, `models.db`, `history.db`): SQLite databases and WAL caches
- `sessions/`, `state/`, `blobs/`, `terminal-sessions/`, `cache/`, `natives/`, `logs/`, `run/`, `wt/`, `.git-sync/`: Local session history, process sockets, worktrees, and machine state
- `node_modules/`, `npm/`, `git/`, `bin/`: Dependencies and binaries
- `last-changelog-version`: Machine changelog tracking

### 4-Tier Guard Enforcement
1. **Tier 1 (Inverted `.gitignore`):** Ignores `*` by default and un-ignores only explicit allowed paths, followed by a hard denylist.
2. **Tier 2 (`.git/info/exclude`):** Non-committable secondary barrier ensuring denylist rules hold even if `.gitignore` is modified.
3. **Tier 3 (Pre-Commit Staging Blocker):** Inspects staged files via `git diff --cached --name-only -z` and aborts the commit if any sensitive file was staged (even with `git add -f`).
4. **Tier 4 (Tracked Secrets Scanner):** Scans `git ls-files -z` during status and sync to alert if sensitive files were previously tracked.

---

## Machine-Local Settings Filter

Oh My Pi `config.yml` and `settings.json` use a zero-dependency clean/smudge filter:
- **Clean Mode:** Strips machine-specific and sensitive keys (`images.urls.credentials`, `dev.autoqaPush.token`, `searxng.*`, `hindsight.*`, `auth.broker.*`, `setupVersion`, `shellPath`, `python.interpreter`, etc.) before committing to git.
- **Smudge Mode:** Merges local machine keys back from `.git-sync/config.machine.yml` and `.git-sync/settings.machine.json` on checkout.

---

## Configuration (`omp-sync.jsonc`)

Create `~/.omp/agent/omp-sync.jsonc` (or `git-sync.jsonc`):

```jsonc
{
  "autoSyncIntervalMinutes": 5,
  "includeHostname": true,
  "extraPaths": ["custom-safe-dir"],
  "warnOnPublicRemote": true,
  "machineLocalSettings": ["lastChangelogVersion", "setupVersion"],
  "machineLocalYamlKeys": [
    "setupVersion",
    "shellPath",
    "dev.autoqaPush.token",
    "images.urls.credentials"
  ]
}
```

---

## License

[MIT](LICENSE) © 2026 aaxyat
