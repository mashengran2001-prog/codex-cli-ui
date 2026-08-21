import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CliLifecycleBridge,
  decodeCliLifecycleEvent,
  hasClaudeHooks,
  hasCodexNotify,
  installClaudeHooks,
  installCodexNotify,
  uninstallClaudeHooks,
  uninstallCodexNotify,
} from "../dist-electron/electron/cli-lifecycle.js";

const helper = "C:\\Users\\Test User\\AppData\\cli-lifecycle-hook.ps1";
const originalNotify = ["python.exe", "C:\\tools\\notify.py", "--quiet"];
const codexSource = [
  "# preserve this comment",
  'model = "gpt-test"',
  `notify = ${JSON.stringify(originalNotify)} # keep inline`,
  "",
  "[features]",
  "web_search = true",
  "",
].join("\r\n");

const installedCodex = installCodexNotify(codexSource, helper);
assert.equal(installedCodex.changed, true);
assert.equal(hasCodexNotify(installedCodex.content), true);
assert.match(installedCodex.content, /# preserve this comment/);
assert.match(installedCodex.content, /# keep inline/);
assert.match(installedCodex.content, /\[features\]\r\nweb_search = true/);
assert.equal(installCodexNotify(installedCodex.content, helper).changed, false);
const restoredCodex = uninstallCodexNotify(installedCodex.content);
assert.equal(restoredCodex.changed, true);
assert.match(restoredCodex.content, new RegExp(`notify = ${JSON.stringify(originalNotify).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
assert.equal(hasCodexNotify(restoredCodex.content), false);

const tableOnly = "[features]\nweb_search = true\n";
const insertedBeforeTable = installCodexNotify(tableOnly, helper).content;
assert.ok(insertedBeforeTable.indexOf("notify =") < insertedBeforeTable.indexOf("[features]"));
assert.throws(() => installCodexNotify('notify = "not-an-array"\n', helper), /array of strings/);
assert.throws(() => installCodexNotify("notify = [\n", helper));

const claudeSource = JSON.stringify({
  env: { KEEP: "1" },
  hooks: {
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-stop-hook" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit-hook" }] }],
  },
}, null, 2);
const installedClaude = installClaudeHooks(claudeSource, helper);
assert.equal(installedClaude.changed, true);
assert.equal(hasClaudeHooks(installedClaude.content), true);
assert.equal(installClaudeHooks(installedClaude.content, helper).changed, false);
const removedClaude = uninstallClaudeHooks(installedClaude.content);
const removedClaudeValue = JSON.parse(removedClaude.content);
assert.equal(removedClaude.changed, true);
assert.equal(removedClaudeValue.env.KEEP, "1");
assert.equal(removedClaudeValue.hooks.Stop[0].hooks[0].command, "user-stop-hook");
assert.equal(removedClaudeValue.hooks.PreToolUse[0].hooks[0].command, "audit-hook");
assert.equal(hasClaudeHooks(removedClaude.content), false);
assert.throws(() => installClaudeHooks("{broken", helper));
assert.throws(() => installClaudeHooks(JSON.stringify({ hooks: { Stop: "bad" } }), helper), /must be an array/);

const decoded = decodeCliLifecycleEvent({
  version: 1,
  source: "claude",
  sessionId: "22222222-2222-4222-8222-222222222222",
  payload: JSON.stringify({ hook_event_name: "Notification", message: "Permission required", session_id: "abc-123" }),
  timestamp: 123,
});
assert.deepEqual(decoded, {
  source: "claude",
  sessionId: "22222222-2222-4222-8222-222222222222",
  aiSessionId: "abc-123",
  kind: "attention",
  message: "Permission required",
  timestamp: 123,
});

const decodedCodex = decodeCliLifecycleEvent({
  version: 1,
  source: "codex",
  sessionId: "33333333-3333-4333-8333-333333333333",
  payload: JSON.stringify({ hook_event_name: "UserPromptSubmit", thread_id: "run_9f2c1b" }),
  timestamp: 124,
});
assert.equal(decodedCodex?.kind, "started");
assert.equal(decodedCodex?.aiSessionId, "run_9f2c1b");

const decodedNoId = decodeCliLifecycleEvent({
  version: 1,
  source: "claude",
  sessionId: "44444444-4444-4444-8444-444444444444",
  payload: JSON.stringify({ hook_event_name: "Notification", session_id: "bad id with spaces" }),
  timestamp: 125,
});
assert.equal(decodedNoId?.aiSessionId, undefined);

if (process.platform === "win32") {
  const root = await mkdtemp(join(tmpdir(), "codex-ui-lifecycle-"));
  const userDataDir = join(root, "user-data");
  const codexHome = join(root, "codex-home");
  const claudeHome = join(root, "claude-home");
  const codexConfig = join(codexHome, "config.toml");
  const claudeSettings = join(claudeHome, "settings.json");
  await Promise.all([mkdir(userDataDir, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(claudeHome, { recursive: true })]);
  await writeFile(codexConfig, codexSource, "utf8");
  await writeFile(claudeSettings, claudeSource, "utf8");
  const bridge = new CliLifecycleBridge({
    userDataDir,
    helperTemplatePath: resolve("scripts", "cli-lifecycle-hook.ps1"),
    codexHome,
    claudeHome,
    onEvent: () => undefined,
  });
  try {
    await bridge.initialize();
    let status = await bridge.setEnabled(true);
    assert.equal(status.enabled, true);
    assert.equal(status.watching, true);
    assert.ok(status.integrations.every((integration) => integration.installed));
    assert.equal(await readFile(`${codexConfig}.bak`, "utf8"), codexSource);
    assert.equal(await readFile(`${claudeSettings}.bak`, "utf8"), claudeSource);

    await writeFile(codexConfig, 'model = "switched"\n', "utf8");
    await writeFile(claudeSettings, "{}\n", "utf8");
    await bridge.repairNow();
    assert.equal(hasCodexNotify(await readFile(codexConfig, "utf8")), true);
    assert.equal(hasClaudeHooks(await readFile(claudeSettings, "utf8")), true);

    status = await bridge.setEnabled(false);
    assert.equal(status.enabled, false);
    assert.equal(status.watching, false);
    assert.equal(hasCodexNotify(await readFile(codexConfig, "utf8")), false);
    assert.equal(hasClaudeHooks(await readFile(claudeSettings, "utf8")), false);
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

console.log("cli-lifecycle: TOML/JSON safety, chaining, backup, and self-healing passed");
