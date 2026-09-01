import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRepoReference } from "../src/gh.js";
import { git, hasDotGit, isSyncableRepo } from "../src/git.js";

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
