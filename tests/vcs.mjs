import assert from "node:assert/strict";
import {
  parseSvnStatus,
  parseSvnRevision,
  parseSvnWorkingCopyRoot,
  scopeSvnEntries,
  svnActionArgs,
} from "../dist-electron/electron/vcs.js";

// Plain `svn status` output: seven columns + working-copy-root relative path.
const statusSample = [
  "M       src/main.rs",
  "A       README.md",
  "D       old.txt",
  "?       build/",
  "M       src/lib/core.ts",
  "Status against revision:   124",
].join("\r\n");

const entries = parseSvnStatus(statusSample);
assert.deepEqual(entries, [
  { status: "M", path: "src/main.rs" },
  { status: "A", path: "README.md" },
  { status: "D", path: "old.txt" },
  { status: "?", path: "build/" },
  { status: "M", path: "src/lib/core.ts" },
]);

const infoSample = [
  "Path: .",
  "Working Copy Root Path: D:\\repo",
  "URL: https://svn.example.com/repo/trunk",
  "Revision: 124",
  "Node Kind: directory",
].join("\n");
assert.equal(parseSvnRevision(infoSample), "124");
assert.equal(parseSvnWorkingCopyRoot(infoSample), "D:\\repo");
assert.equal(parseSvnRevision("no revision here"), null);
assert.equal(parseSvnWorkingCopyRoot("nothing"), null);

// Scope: WC-root entries rewritten to be drawer-root relative, outside dropped.
const scoped = scopeSvnEntries(entries, "src");
assert.deepEqual(scoped, [
  { status: "M", path: "main.rs" },
  { status: "M", path: "lib/core.ts" },
]);
assert.deepEqual(scopeSvnEntries(entries, ""), entries);
assert.deepEqual(scopeSvnEntries(entries, "src/lib"), [
  { status: "M", path: "core.ts" },
]);

// Action translation: add --force / revert / commit / update, pull+push rejected.
assert.deepEqual(svnActionArgs({ action: "stage", paths: [], message: "" }), { args: ["add", "--force", "."] });
assert.deepEqual(svnActionArgs({ action: "stage", paths: ["src/a.ts", "src/b.ts"], message: "" }), { args: ["add", "--force", "src/a.ts", "src/b.ts"] });
assert.deepEqual(svnActionArgs({ action: "unstage", paths: [], message: "" }), { error: "请先选择要还原的文件" });
assert.deepEqual(svnActionArgs({ action: "unstage", paths: ["src/a.ts"], message: "" }), { args: ["revert", "src/a.ts"] });
assert.deepEqual(svnActionArgs({ action: "commit", paths: [], message: "  fix parser  " }), { args: ["commit", "-m", "fix parser"] });
assert.deepEqual(svnActionArgs({ action: "commit", paths: ["src/a.ts"], message: "" }), { error: "提交说明不能为空" });
assert.deepEqual(svnActionArgs({ action: "update", paths: [], message: "" }), { args: ["update", "--non-interactive"] });
assert.equal(svnActionArgs({ action: "pull", paths: [], message: "" }).error, "SVN 仓库不支持拉取/推送，请使用更新与提交");
assert.equal(svnActionArgs({ action: "push", paths: [], message: "" }).error, "SVN 仓库不支持拉取/推送，请使用更新与提交");
assert.deepEqual(svnActionArgs({ action: "unknown", paths: [], message: "" }), { error: "Unsupported SVN action" });

console.log("vcs: SVN status/info parsing, scoping, and action translation passed");
