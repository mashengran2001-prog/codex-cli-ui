import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createElectronFixture, launcherArgs } from "./electron-fixture.mjs";
import { root } from "./browser-harness.mjs";

const testRoot = join(root, ".tmp", "electron-workflow");
const codexHome = join(testRoot, "codex-home");
const userData = join(testRoot, "user-data");
await rm(testRoot, { recursive: true, force: true });
await mkdir(testRoot, { recursive: true });
await createElectronFixture(root, codexHome);

const electronEnv = {
  ...process.env,
  CODEX_UI_CLI_PATH: process.execPath,
  CODEX_UI_CLI_PREFIX_ARGS: JSON.stringify([join(root, "tests", "fake-codex.mjs")]),
  CODEX_UI_CODEX_HOME: codexHome,
  CODEX_UI_USER_DATA_DIR: userData,
  TEMP: join(root, ".tmp"),
  TMP: join(root, ".tmp"),
};

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, ...launcherArgs(root)],
  cwd: root,
  env: electronEnv,
  timeout: 30_000,
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByText("Imported session").waitFor({ timeout: 15_000 });
  await window.getByText("Imported session").click();
  await window.getByText("Imported response is ready.").waitFor();
  assert.match(await window.locator(".reasoning-content").textContent(), /Checking the parser/);
  assert.match(await window.locator(".activity-row").textContent(), /shell_command/);

  await window.getByText("Fix the parser from CLI").first().click();
  const textarea = window.locator("textarea");
  await textarea.waitFor();
  assert.equal(await textarea.inputValue(), "Fix the parser from CLI");
  await window.locator(".send-button").click();
  await window.getByText(/Completed from fake Codex/).waitFor({ timeout: 15_000 });
  assert.match(await window.locator(".composer-status").textContent(), /(?:会话|Session) 33333333/);
  assert.match(await window.locator(".activity-row").last().textContent(), /npm test/);
  assert.match(await window.locator(".sidebar-status").textContent(), /0.145.0-test/);

  await window.getByRole("tab", { name: "终端" }).click();
  await window.locator(".xterm-helper-textarea").waitFor({ timeout: 15_000 });
  await window.locator(".xterm-helper-textarea").focus();
  await window.keyboard.type('Write-Output ("NEBULA" + "_PTY_OK")', { delay: 12 });
  await window.keyboard.press("Enter");
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("NEBULA_PTY_OK"), undefined, { timeout: 15_000 });
  assert.equal(await window.evaluate(async () => (await window.codex.listTerminals()).length), 1);
  console.log("electron-workflow: Codex IPC, session persistence, and real ConPTY terminal passed");
} finally {
  await app.close();
}

const restoredApp = await electron.launch({
  executablePath: electronPath,
  args: [root],
  cwd: root,
  env: electronEnv,
  timeout: 30_000,
});

try {
  const window = await restoredApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByRole("tab", { name: "终端" }).waitFor({ timeout: 15_000 });
  await window.getByRole("tab", { name: "终端" }).click();
  await window.locator(".xterm-screen").waitFor({ timeout: 15_000 });
  assert.equal(await window.evaluate(async () => (await window.codex.listTerminals()).length), 1);
  assert.match(await window.locator(".terminal-tab").textContent(), /codex-ui/);
  console.log("electron-restore: terminal snapshot recreated the project tab after restart");
} finally {
  await restoredApp.close();
}
