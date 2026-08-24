import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { root } from "./browser-harness.mjs";

const require = createRequire(import.meta.url);
const { worktreeSlug, stableHash, WorktreeTransaction } = require(join(root, "dist-electron", "electron", "git-worktree.js"));

function norm(value) {
  return String(value).replaceAll("\\", "/");
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

async function testRepository() {
  const dir = join(root, ".tmp", "git-worktree-unit");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "--initial-branch=main"]);
  await writeFile(join(dir, "tracked.txt"), "tracked");
  git(dir, ["add", "tracked.txt"]);
  git(dir, ["-c", "user.name=Nebula Test", "-c", "user.email=nebula@example.invalid", "commit", "-m", "initial"]);
  return dir;
}

// slug is path/branch safe (mirrors nebula_app git_worktree.rs tests)
assert.equal(worktreeSlug("Fix Login / Windows"), "fix-login-windows");
assert.equal(worktreeSlug("  审查 API  "), "审查-api");
assert.ok(worktreeSlug("///").startsWith("agent-"));
assert.equal(worktreeSlug("///"), "agent-" + stableHash("///").toString(16).padStart(8, "0"));

const repo = await testRepository();

// prepare + rollback removes exactly what the transaction created
const target = join(repo, "worktrees", "reviewer");
const transaction = await WorktreeTransaction.prepare({
  source_cwd: repo,
  agent_name: "reviewer",
  branch: "nebula/test-reviewer",
  base: undefined,
  path: target,
  allow_dirty_source: false,
});
assert.ok(existsSync(join(target, "tracked.txt")));
const provenance = transaction.provenance();
assert.equal(provenance.branch, "nebula/test-reviewer");
assert.equal(norm(provenance.repo_root), norm(repo));
assert.equal(norm(provenance.source_root), norm(repo));
assert.equal(provenance.created, true);
assert.ok(provenance.base_commit.length >= 7);
await transaction.rollback();
assert.ok(!existsSync(target));
assert.throws(() => git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/nebula/test-reviewer"]));

// commit keeps resources for the caller to manage
const keeper = join(repo, "worktrees", "keeper");
const keeperTx = await WorktreeTransaction.prepare({
  source_cwd: repo,
  agent_name: "keeper",
  branch: "nebula/keeper",
  base: undefined,
  path: keeper,
  allow_dirty_source: false,
});
keeperTx.commit();
assert.ok(existsSync(keeper));
git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/nebula/keeper"]);
git(repo, ["worktree", "remove", "--force", keeper]);
git(repo, ["branch", "-D", "nebula/keeper"]);

// dirty source requires explicit opt-in
await writeFile(join(repo, "untracked.txt"), "dirty");
let error;
try {
  await WorktreeTransaction.prepare({ source_cwd: repo, agent_name: "dirty", path: join(repo, "worktrees", "dirty"), allow_dirty_source: false });
} catch (caught) {
  error = caught;
}
assert.equal(error.code, "dirty_source");
assert.ok(!existsSync(join(repo, "worktrees", "dirty")));

// branch conflict is rejected before any worktree is created
const conflict = join(repo, "worktrees", "conflict");
const conflictTx = await WorktreeTransaction.prepare({
  source_cwd: repo,
  agent_name: "conflict",
  branch: "nebula/conflict",
  path: conflict,
  allow_dirty_source: true,
});
conflictTx.commit();
try {
  await WorktreeTransaction.prepare({
    source_cwd: repo,
    agent_name: "conflict",
    branch: "nebula/conflict",
    path: join(repo, "worktrees", "conflict2"),
    allow_dirty_source: true,
  });
  assert.fail("branch conflict must be rejected");
} catch (caught) {
  assert.equal(caught.code, "branch_conflict");
}
assert.ok(!existsSync(join(repo, "worktrees", "conflict2")));
git(repo, ["worktree", "remove", "--force", conflict]);
git(repo, ["branch", "-D", "nebula/conflict"]);

console.log("git-worktree: slug, transactional prepare/commit/rollback, dirty-source, and branch-conflict checks passed");
