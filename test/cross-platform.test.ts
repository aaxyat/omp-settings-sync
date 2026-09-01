import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dirOf, stripJsonComments } from "../src/config.js";
import { generateFilterScript } from "../src/filter.js";
import { gitEnv } from "../src/git.js";
import { isDenied } from "../src/security.js";

test("cross-platform path resolution handles Windows backslashes and POSIX slashes", () => {
  const originalPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "C:\\Users\\tester\\.omp\\custom-agent";
    const resolved = dirOf();
    assert.ok(resolved.includes("custom-agent"));

    process.env.PI_CODING_AGENT_DIR = "~/posix/custom-agent";
    const resolvedPosix = dirOf();
    assert.ok(resolvedPosix.includes("custom-agent"));
  } finally {
    if (originalPiDir) process.env.PI_CODING_AGENT_DIR = originalPiDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("cross-platform CRLF comment stripping handles Windows and POSIX line endings", () => {
  const crlfJsonc = '{\r\n  // Windows comment\r\n  "key": "value"\r\n}';
  const strippedCrlf = stripJsonComments(crlfJsonc);
  assert.equal(JSON.parse(strippedCrlf).key, "value");

  const lfJsonc = '{\n  // POSIX comment\n  "key": "value"\n}';
  const strippedLf = stripJsonComments(lfJsonc);
  assert.equal(JSON.parse(strippedLf).key, "value");
});

test("cross-platform gitEnv normalizes ceiling directories", () => {
  const env = gitEnv("C:\\Users\\tester\\.omp\\agent");
  assert.ok(env.GIT_CEILING_DIRECTORIES);
  assert.doesNotMatch(env.GIT_CEILING_DIRECTORIES, /\\/);
});

test("cross-platform isDenied handles Windows and POSIX backslashes and case variations", () => {
  assert.equal(isDenied("C:\\Users\\tester\\.omp\\agent\\auth.json"), true);
  assert.equal(isDenied("extensions\\secrets\\api_key.json"), true);
  assert.equal(isDenied("Extensions/Secrets/TOKEN.txt"), true);
  assert.equal(isDenied("sessions\\abc\\session.jsonl"), true);
  assert.equal(isDenied("agent.DB-wal"), true);
  assert.equal(isDenied("config.YML"), false);
  assert.equal(isDenied("extensions\\tps.ts"), false);
});
