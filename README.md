# omp-settings-sync

[![npm](https://img.shields.io/npm/v/omp-settings-sync)](https://www.npmjs.com/package/omp-settings-sync)
[![CI](https://github.com/aaxyat/omp-settings-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/aaxyat/omp-settings-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Securely sync your [Oh My Pi](https://omp.sh) (`~/.omp/agent`) configuration, session tokens, and login credentials across devices (Linux, macOS, Windows) through a private Git remote (`OhMyPiSyncData`) — automatically, with 4-tier guards keeping plaintext secrets, databases, and runtime state out.

The agent directory (`~/.omp/agent` or `~/.omp/profiles/<profile>/agent`) **is** the repository, ensuring transparent version history with zero shadow staging copies.

---

## Features

- 🔒 **Encrypted Credentials Vault:** Optional password-protected AES-256-GCM encrypted vault (`vault.enc`) to synchronize session tokens and logins (`auth.json`, `auth-broker.json`) safely across devices.
- ⚡ **Instant Startup Sync & Progress Bar:** Automatically syncs immediately upon opening/starting Oh My Pi with a visual progress bar indicator (`🔄 Sync [█████░░░░░] 50% Fetching...`).
- ⏱️ **1-Minute Background Sync:** Periodically checks every 60 seconds and syncs automatically whenever local or remote changes are detected.
- 💻 **Cross-Platform Compatibility:** Full native support for Windows, macOS, and Linux with robust path normalization, CRLF/LF line-ending preservation, and safe process locking.
- 🛡️ **4-Tier Security Guards:** Inverted allowlist `.gitignore`, local `.git/info/exclude`, pre-commit staging blocker, and tracked file scanner ensuring plaintext secrets, tokens, and SQLite databases (`agent.db*`, `models.db*`, `history.db*`) are never committed.
- ⚙️ **Dual YAML & JSON Clean/Smudge Filter:** Machine-local settings (`images.urls.credentials`, `dev.autoqaPush.token`, `searxng.*`, `hindsight.*`, `auth.broker.*`, `setupVersion`, `shellPath`, etc.) are stripped from commits and preserved in local sidecars.
- 🚀 **Zero-Touch GitHub Setup:** Automatically creates and discovers private `OhMyPiSyncData` repositories using authenticated GitHub CLI (`gh`).
- 🔄 **Graceful Onboarding:** Linking on a new device without entering a password syncs all unencrypted configuration smoothly without errors; unlock your encrypted vault anytime via `/ompsync unlock`.

---

## Installation

### Method 1: Oh My Pi Plugin CLI
```sh
omp plugin install omp-settings-sync
```

Or from a specific scoped package/version:
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

### 1. First Machine Setup
Run:
```text
/ompsync init
```
1. It asks if you want to securely sync session tokens and credentials. If confirmed, enter a passphrase.
2. With GitHub CLI authenticated (`gh auth login`), it creates a private `OhMyPiSyncData` repository, commits allowlisted configuration and encrypted vault, and pushes to GitHub.

Without `gh`, specify a private remote:
```text
/ompsync init git@github.com:you/OhMyPiSyncData.git
```

### 2. Linking on New Devices (Windows / macOS / Linux)
On your second device, run:
```text
/ompsync link
```
- Enter your vault passphrase to decrypt and restore session tokens (`auth.json`).
- **If you skip or leave the passphrase blank:** All unencrypted configuration syncs normally with zero errors. You can unlock your credentials vault anytime later.
- Any differing local allowed files are safely preserved as `<file>.local-backup`.

### 3. Daily Synchronization
Synchronization is fully automated:
- **On Opening (Startup):** Automatically syncs and pulls remote updates on session start with progress bar feedback.
- **Background Checks:** Runs every 60 seconds and synchronizes whenever local or remote changes are detected.
- **Session Shutdown:** Performs a fast best-effort commit and push.

---

## Commands

| Command | Description |
| :--- | :--- |
| `/ompsync init [url\|name]` | Initialize and push the first-machine repository (`OhMyPiSyncData`) |
| `/ompsync link [url\|name]` | Link an existing sync repository on a new machine |
| `/ompsync status` | Display repository state, branch, vault status, and security checks |
| `/ompsync sync` | Commit, fetch, integrate remote changes (rebase), and push with progress indicator |
| `/ompsync push` | Commit and push local changes without pulling |
| `/ompsync pull` | Fetch and rebase remote updates |
| `/ompsync unlock [passphrase]` | Decrypt credentials vault and restore local `auth.json` |
| `/ompsync lock` | Clear cached vault key from local machine memory and cache |
| `/ompsync vault enable [passphrase]` | Enable encrypted credentials vault and encrypt `auth.json` |
| `/ompsync vault disable` | Disable and remove credentials vault from repository |

---

## Cross-Platform Compatibility

- **Windows:** Supports Windows backslashes in paths, drive letters (`C:\...`), POSIX Git ceiling directory normalization, CRLF line endings, and safe file locking without file descriptor deadlocks.
- **macOS:** Native support for macOS home directories (`/Users/...`) and case-insensitive APFS/HFS+ file systems.
- **Linux:** Standard POSIX support with case-sensitive ext4 filesystem rules.

---

## Security Model

### What Syncs in Plaintext (Allowlist)
- `config.yml` / `config.yaml`: Global model defaults, themes, tool parameters (with machine-local & sensitive keys stripped)
- `mcp.json`: Model Context Protocol server registrations
- `settings.json`: Legacy/migrated settings
- `AGENTS.md` / `Agents.md`: Global instructions and directives
- `extensions/`, `skills/`, `agents/`, `chains/`, `prompts/`, `themes/`, `plugins/`: Custom resources
- `.gitignore`, `.gitattributes`, `omp-sync.jsonc`: Sync policy

### What Syncs Encrypted (Vault)
- `vault.enc`: AES-256-GCM encrypted payload containing `auth.json`, `auth-broker.json`, and login session tokens.

### What NEVER Syncs in Plaintext (Hard Denylist)
- `auth*` (`auth.json`, `auth-broker.json`): Raw plaintext API keys and OAuth tokens
- `*token*`, `*secret*`, `*credential*`, `*.env*`, `*.local.json`, `*.local.yml`: Plaintext secrets
- `*.db`, `*.db-*`, `*.sqlite*` (`agent.db`, `models.db`, `history.db`): SQLite databases and WAL caches
- `sessions/`, `state/`, `blobs/`, `terminal-sessions/`, `cache/`, `natives/`, `logs/`, `run/`, `wt/`, `.git-sync/`: Local session history, process sockets, worktrees, and machine state
- `node_modules/`, `npm/`, `git/`, `bin/`: Dependencies and binaries
- `last-changelog-version`: Machine changelog tracking

---

## Configuration (`omp-sync.jsonc`)

Create `~/.omp/agent/omp-sync.jsonc` (or `git-sync.jsonc`):

```jsonc
{
  "autoSyncIntervalMinutes": 1,
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
