import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createElectronFixture, launcherArgs } from "./electron-fixture.mjs";
import { root } from "./browser-harness.mjs";

const testRoot = join(root, ".tmp", "electron-workflow");
const codexHome = join(testRoot, "codex-home");
const userData = join(testRoot, "user-data");
const shellStartupRoot = join(testRoot, "shell-startup");
const shellStartupRegistry = `HKCU:\\Software\\CodexCliUiTest\\Electron-${process.pid}`;
const exportProbe = join(testRoot, "export-probe.txt");
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
  CODEX_UI_SHELL_STARTUP_WINDOWS_PROFILE: join(shellStartupRoot, "WindowsPowerShell", "profile.ps1"),
  CODEX_UI_SHELL_STARTUP_PWSH_PROFILE: join(shellStartupRoot, "PowerShell", "profile.ps1"),
  CODEX_UI_SHELL_STARTUP_HOOK_PATH: join(shellStartupRoot, "hooks", "shell-startup.ps1"),
  CODEX_UI_SHELL_STARTUP_REGISTRY_PATH: shellStartupRegistry,
  CODEX_UI_EXPORT_PATH: exportProbe,
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
  // 真实 readDocumentImage IPC 验证
  const probeImg = join(root, "probe-img-test.png");
  const { writeFile, readFile, rm: rmFile } = await import("node:fs/promises");
  await writeFile(probeImg, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  try {
    const result = await window.evaluate(async ([r, p]) => await window.codex.readDocumentImage(r, p), [root, probeImg]);
    assert.match(result, /^data:image\/png;base64,/);
    const resultNull = await window.evaluate(async ([r, p]) => await window.codex.readDocumentImage(r, p), [root, "C:\\Windows\\win.ini"]);
    assert.equal(resultNull, null);
    console.log("electron-image: readDocumentImage IPC verified");
  } finally {
    await rmFile(probeImg).catch(() => {});
  }
  // 真实 terminal:export-session IPC 验证（通过 CODEX_UI_EXPORT_PATH 绕过保存对话框）
  const sessionId = (await window.evaluate(async () => (await window.codex.listTerminals())[0].id));
  const exportedPath = await window.evaluate(async (id) => window.codex.exportTerminalSession(id, "NEBULA_PTY_OK line\nsecond line"), sessionId);
  assert.equal(exportedPath, exportProbe);
  assert.match(await readFile(exportProbe, "utf8"), /NEBULA_PTY_OK line/);
  console.log("electron-export: terminal:export-session IPC verified");
  await window.locator(".terminal-actions").getByTitle("更多操作").click(); await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByLabel("打开 PowerShell/CMD 时唤起工作台").check();
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).shellStartupIntegration === true, undefined, { timeout: 15_000 });
  await window.getByLabel("打开 PowerShell/CMD 时唤起工作台").uncheck();
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).shellStartupIntegration === false, undefined, { timeout: 15_000 });
  // 代理仅注入工作台子进程：设置代理后新建终端，子进程应看到 HTTPS_PROXY，且清空后新终端不再携带
  await window.getByLabel("代理地址").fill("http://127.0.0.1:7890");
  await window.getByLabel("不走代理的地址").fill("localhost,127.0.0.1");
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).proxyUrl === "http://127.0.0.1:7890", undefined, { timeout: 15_000 });
  await window.getByRole("button", { name: "返回工作台" }).click();
  const proxySessionCount = await window.evaluate(async () => (await window.codex.listTerminals()).length);
  await window.getByTitle("新建终端").first().click();
  await window.waitForFunction((count) => (async () => (await window.codex.listTerminals()).length === count + 1)(), proxySessionCount, { timeout: 15_000 });
  // 新标签默认不激活，点击新标签让其 xterm 挂载后再输入
  const newSessionId = await window.evaluate(async () => (await window.codex.listTerminals()).at(-1).id);
  await window.locator(`.terminal-top-tab[data-session-id="${newSessionId}"] .terminal-tab-main`).click();
  await window.locator(".terminal-pane-leaf[data-session-id='" + newSessionId + "'] .xterm-helper-textarea").waitFor({ timeout: 15_000 });
  await window.locator(".terminal-pane-leaf[data-session-id='" + newSessionId + "'] .xterm-helper-textarea").focus();
  await window.keyboard.type('Write-Output ("PROXY=" + $env:HTTPS_PROXY)', { delay: 8 });
  await window.keyboard.press("Enter");
  await window.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("PROXY=http://127.0.0.1:7890"), undefined, { timeout: 15_000 });
  // 关闭代理测试终端，避免它进入会话快照影响重启恢复断言
  const sessionIdsBeforeClose = await window.evaluate(async () => (await window.codex.listTerminals()).map((terminal) => terminal.id));
  assert.equal(sessionIdsBeforeClose.length, proxySessionCount + 1);
  const lastSessionId = sessionIdsBeforeClose.at(-1);
  const closed = await window.evaluate((id) => {
    const tab = document.querySelector(`.terminal-tab[data-session-id="${id}"]`) || document.querySelector(`.terminal-top-tab[data-session-id="${id}"]`);
    if (!tab) return "no-tab";
    const button = tab.querySelector(".terminal-tab-close");
    if (!button) return "no-button";
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return "clicked";
  }, lastSessionId);
  assert.equal(closed, "clicked");
  await window.waitForFunction(async (expected) => (await window.codex.listTerminals()).length === expected, proxySessionCount, { timeout: 10_000 });
  await window.locator(".terminal-actions").getByTitle("更多操作").click(); await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByLabel("代理地址").fill("");
  await window.getByLabel("不走代理的地址").fill("");
  await window.waitForFunction(async () => (await window.codex.getAppSettings()).proxyUrl === "", undefined, { timeout: 15_000 });
  console.log("electron-workflow: Codex IPC, session persistence, real ConPTY terminal, and per-window proxy passed");
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
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${shellStartupRegistry}' -Recurse -Force -ErrorAction SilentlyContinue`], { windowsHide: true }); } catch {}
}
