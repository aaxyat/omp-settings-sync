import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GhClient } from "./gh.js";
import { isDenied } from "./security.js";

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
  gh?: GhClient;
  notify?: (message: string, level: Level) => void;
}

export interface UIContext {
  hasUI?: boolean;
  ui?: {
    setStatus(key: string, status?: string): void;
    notify(message: string, level: Level): void;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
    confirm?(title: string, message: string): Promise<boolean>;
    select?(
      title: string,
      options: Array<{ label: string; value?: string; description?: string }>
    ): Promise<string | undefined>;
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
