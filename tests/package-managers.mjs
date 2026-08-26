import assert from "node:assert/strict";
import {
  buildScoopUpdateCommand,
  buildWingetUpdateCommand,
  detectPackageManager,
  parseScoopVersionOutput,
  parseWingetVersionOutput,
  scoopListContains,
  wingetListContains,
  WINGET_PACKAGE_ID,
  SCOOP_APP_NAME,
} from "../dist-electron/electron/package-managers.js";

// ---- winget 版本输出解析 ----
assert.equal(parseWingetVersionOutput(null), false);
assert.equal(parseWingetVersionOutput(""), false);
assert.equal(parseWingetVersionOutput("v1.9.4411"), true);
assert.equal(parseWingetVersionOutput("1.9.4411\nWindows Package Manager"), true);
assert.equal(parseWingetVersionOutput("'winget' is not recognized"), false);

// ---- winget list 已安装匹配 ----
assert.equal(wingetListContains(null), false);
assert.equal(wingetListContains(""), false);
const wingetListWithApp = [
  "Name               Id                      Version   Available   Source",
  "Codex CLI UI       CodexCLIUI.CodexCLIUI   0.2.0     0.2.1       winget",
  "1 package(s) found.",
].join("\r\n");
assert.equal(wingetListContains(wingetListWithApp), true);
assert.equal(wingetListContains("Name   Id   Version\nfoo     bar   1.0"), false);
assert.equal(wingetListContains("Codex CLI UI  0.2.0"), true);

// ---- scoop 版本输出解析 ----
assert.equal(parseScoopVersionOutput(null), false);
assert.equal(parseScoopVersionOutput("Scoop version v0.5.2"), true);
assert.equal(parseScoopVersionOutput("v0.5.2"), true);
assert.equal(parseScoopVersionOutput("'scoop' is not recognized"), false);

// ---- scoop list 已安装匹配 ----
assert.equal(scoopListContains(null), false);
assert.equal(scoopListContains("codex-cli-ui  0.2.0   bucket"), true);
assert.equal(scoopListContains("codex-cli-ui 0.2.0"), true);
assert.equal(scoopListContains("other-app 1.0"), false);
assert.equal(scoopListContains("mycodex-cli-ui-extra 1.0"), false);

// ---- 升级命令构造 ----
assert.equal(buildWingetUpdateCommand(), `winget upgrade --id "${WINGET_PACKAGE_ID}" --silent --accept-package-agreements --accept-source-agreements`);
assert.equal(buildScoopUpdateCommand(), `scoop update ${SCOOP_APP_NAME}`);
assert.equal(buildWingetUpdateCommand("Acme.App"), "winget upgrade --id \"Acme.App\" --silent --accept-package-agreements --accept-source-agreements");
assert.equal(buildScoopUpdateCommand("my-app"), "scoop update my-app");

// ---- 探测结果 → 分发来源推导 ----
assert.deepEqual(
  detectPackageManager({ hasWinget: false, hasScoop: false }),
  { source: null, command: null, label: null },
);
assert.deepEqual(
  detectPackageManager({ hasWinget: true, wingetListOutput: wingetListWithApp, hasScoop: false }),
  { source: "winget", command: buildWingetUpdateCommand(), label: "winget" },
);
assert.deepEqual(
  detectPackageManager({ hasWinget: true, wingetListOutput: "nothing", hasScoop: true, scoopListOutput: "codex-cli-ui 0.2.0" }),
  { source: "scoop", command: buildScoopUpdateCommand(), label: "scoop" },
);
assert.deepEqual(
  detectPackageManager({ hasWinget: true, wingetListOutput: "nothing", hasScoop: true, scoopListOutput: "nothing" }),
  { source: null, command: null, label: null },
);

console.log("package-managers: winget/scoop parsing, command building, and detection passed");
