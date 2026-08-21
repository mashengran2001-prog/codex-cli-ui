import assert from "node:assert/strict";
import { createPopulatedPage, launchBrowser, startPreview } from "./browser-harness.mjs";

const server = await startPreview(4322);
const browser = await launchBrowser();

try {
  const { context, page } = await createPopulatedPage(browser, server.url);
  assert.equal(await page.locator(".project-label strong").textContent(), "atlas-workspace");
  assert.match(await page.locator(".composer-status").textContent(), /会话 11111111/);
  assert.match(await page.locator(".activity-row").textContent(), /npm test/);
  assert.match(await page.locator(".markdown-body").textContent(), /12 tests/);

  const request = await page.evaluate(() => window.__mock.lastRun);
  assert.equal(request.cwd, "F:\\demo\\atlas-workspace");
  assert.equal(request.sandboxMode, "workspace-write");
  assert.equal(request.reasoningEffort, "medium");
  assert.equal(request.providerId, "codex");
  assert.equal(request.prompt, "Fix the parser and run the test suite");

  await page.locator(".composer textarea").fill("/");
  await page.getByRole("button", { name: /\/review/ }).waitFor();
  assert.equal(await page.locator(".command-menu button").count(), 4);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Provider 设置" }).click();
  await page.getByRole("button", { name: "启用" }).click();
  await page.getByText(/codex 打开本界面/).waitFor();
  assert.equal(await page.evaluate(() => window.__mock.launcherInstalled), true);

  assert.equal(await page.locator(".terminal-workspace").count(), 1);
  assert.equal(await page.locator(".sidebar-header").count(), 0);
  await page.getByRole("tab", { name: "终端" }).click();
  await page.getByRole("heading", { name: "CLI 工作台终端" }).waitFor();
  await page.locator(".xterm-screen").waitFor();
  assert.match(await page.locator(".terminal-tab").textContent(), /atlas-workspace/);
  assert.match(await page.locator(".cli-tool-list").textContent(), /Claude Code/);
  await page.evaluate(() => {
    const sessionId = window.__mock.terminalSessions[0].id;
    window.__mock.terminalListeners.forEach((listener) => listener({ sessionId, type: "bell" }));
  });
  await page.getByText("需要处理").waitFor();
  await page.locator(".terminal-notice").click();
  await page.getByRole("button", { name: "命令面板" }).click();
  await page.getByText("工作目录", { exact: false }).waitFor();
  await page.locator(".command-palette").getByRole("button", { name: "复制路径", exact: true }).click();
  await page.getByRole("button", { name: "命令面板" }).click();
  assert.equal(await page.locator(".palette-list section").first().locator("h3").textContent(), "最近使用");
  assert.match(await page.locator(".palette-list section").first().locator("button").first().textContent(), /复制路径/);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "向右拆分" }).click();
  await page.locator(".xterm-screen").nth(1).waitFor();
  assert.equal(await page.locator(".terminal-pane-leaf").count(), 2);
  assert.equal(await page.locator('.terminal-pane-shell[data-active="true"]').count(), 1);

  await page.locator(".terminal-pane-leaf").nth(1).getByRole("button", { name: "关闭分屏" }).click();
  assert.equal(await page.locator(".terminal-pane-leaf").count(), 1);
  await page.locator(".terminal-tab-main").nth(1).click();
  await page.waitForFunction(() => document.querySelector(".terminal-pane-leaf")?.dataset.sessionId === window.__mock.terminalSessions[1].id);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".terminal-settings").waitFor();
  assert.equal(await page.locator(".terminal-side-panel").count(), 0);
  assert.equal(await page.getByRole("button", { name: "向右拆分" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "文件", exact: true }).count(), 0);
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.equal(await page.getByLabel("光标形状").inputValue(), "bar");
  await page.getByLabel("界面语言").selectOption("en-US");
  await page.getByRole("heading", { name: "CLI Workbench Settings" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en-US");
  assert.equal(await page.getByLabel("Cursor shape").inputValue(), "bar");
  assert.equal(await page.getByRole("tab", { name: "Chat" }).count(), 0);
  await page.getByText("Appearance", { exact: true }).waitFor();
  await page.getByLabel("Interface language").selectOption("zh-CN");
  await page.getByRole("heading", { name: "CLI 工作台设置" }).waitFor();
  assert.equal(await page.getByLabel("终端响铃").isChecked(), true);
  assert.equal(await page.getByLabel("加载 PowerShell 配置").isChecked(), false);
  assert.equal(await page.getByLabel("CLI 活动同步").isChecked(), false);
  await page.getByLabel("CLI 活动同步").check();
  await page.waitForFunction(() => document.querySelectorAll(".cli-lifecycle-integrations .tool-status.online").length === 2);
  assert.equal(await page.getByLabel("CLI 活动同步").isChecked(), true);
  assert.equal(await page.getByLabel("打开 PowerShell/CMD 时唤起工作台").isChecked(), false);
  await page.getByLabel("打开 PowerShell/CMD 时唤起工作台").check();
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).shellStartupIntegration, true);
  await page.getByLabel("打开 PowerShell/CMD 时唤起工作台").uncheck();
  await page.getByLabel("加载 PowerShell 配置").check();
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).loadShellProfile, true);
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).language, "zh-CN");

  // 快捷键录制：点命令面板行，按 Ctrl+Alt+K，断言设置持久化且页面显示新 chord
  const paletteRow = page.locator(".keybinding-row").filter({ hasText: "命令面板" });
  await paletteRow.getByRole("button", { name: "Ctrl+Shift+P" }).click();
  await page.keyboard.press("Control+Alt+K");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).keybindings["command-palette"], "Ctrl+Alt+K");
  assert.equal(await paletteRow.getByText("Ctrl+Alt+K", { exact: true }).count(), 1);

  // 界面密度三档：选择紧凑并断言设置与根元素 data-density 同步
  await page.getByLabel("界面密度").selectOption("compact");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).density, "compact");
  assert.equal(await page.locator(".terminal-workspace").getAttribute("data-density"), "compact");
  // 新标签位置：切换为追加到末尾并断言持久化
  await page.getByLabel("新标签页位置").selectOption("end");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).newTabPlacement, "end");
  await page.getByRole("button", { name: "返回工作台" }).click();

  const tabCountBeforeMiddleClick = await page.locator(".terminal-tab").count();
  await page.locator(".terminal-tab").nth(1).click({ button: "middle" });
  await page.waitForFunction((count) => document.querySelectorAll(".terminal-tab").length === count - 1, tabCountBeforeMiddleClick);
  assert.equal(await page.evaluate(() => window.__mock.terminalSessions.length), tabCountBeforeMiddleClick - 1);

  // 标签页颜色：右键菜单选色，断言 data-tab-color 与 localStorage 持久化，再清除
  const coloredTab = page.locator(".terminal-top-tab").first();
  await coloredTab.click({ button: "right" });
  await page.locator(".terminal-tab-colors button").first().click();
  const coloredId = await coloredTab.getAttribute("data-session-id");
  assert.equal(await coloredTab.getAttribute("data-tab-color"), "#e06c75");
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("codex-cli-ui:terminal-colors-v1"))))[coloredId], "#e06c75");
  await coloredTab.click({ button: "right" });
  await page.locator(".terminal-tab-colors button.clear").click();
  assert.equal(await coloredTab.getAttribute("data-tab-color"), "");
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("codex-cli-ui:terminal-colors-v1"))))[coloredId], undefined);

  // 新建标签位置（追加到末尾）：激活首个标签后新建，新标签应出现在末尾
  await page.locator(".terminal-top-tab").nth(0).locator(".terminal-tab-main").click();
  const idsBeforeNewTab = await page.evaluate(() => window.__mock.terminalSessions.map((session) => session.id));
  await page.locator(".terminal-side-panel").getByRole("button", { name: "新建终端" }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll(".terminal-top-tab").length === count, idsBeforeNewTab.length + 1);
  const idsAfterNewTab = await page.locator(".terminal-top-tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-session-id")));
  const newestId = await page.evaluate(() => window.__mock.terminalSessions.at(-1).id);
  assert.deepEqual(idsAfterNewTab, [...idsBeforeNewTab, newestId]);

  await page.getByRole("button", { name: "文件", exact: true }).click();
  const readmeRow = page.locator(".file-row", { hasText: "README.md" });
  await readmeRow.waitFor();
  await readmeRow.dragTo(page.locator(".terminal-pane-leaf .terminal-canvas"));
  await page.waitForFunction(() => window.__mock.terminalWrites.some((write) => write.data === "'F:\\demo\\atlas-workspace\\README.md'"));
  await readmeRow.click();
  await page.getByRole("heading", { name: "Atlas" }).waitFor();
  await page.getByRole("button", { name: "关闭文档" }).click();
  await page.getByRole("button", { name: "Git 状态" }).click();
  await page.getByText("src/App.tsx").waitFor();
  // 剪贴板截图粘贴：剪贴板无文本但有图片时，粘贴本地 PNG 的引号路径
  await page.evaluate(() => { window.__mock.clipboardImage = "F:\\demo\\clipboard.png"; });
  await page.locator(".terminal-pane-leaf").first().locator(".xterm-screen").click();
  await page.keyboard.press("Control+v");
  await page.waitForFunction(() => window.__mock.terminalWrites.some((write) => write.data === "'F:\\demo\\clipboard.png'"));
  await page.evaluate(() => { window.__mock.clipboardImage = null; });
  await page.getByRole("tab", { name: "对话" }).click();
  await page.locator(".composer textarea").waitFor();

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    app: document.querySelector(".app-shell").scrollWidth - document.querySelector(".app-shell").clientWidth,
  }));
  assert.ok(overflow.document <= 1, `document overflowed by ${overflow.document}px`);
  assert.ok(overflow.app <= 1, `app overflowed by ${overflow.app}px`);
  await context.close();
  console.log("workflow: chat, Nebula terminal, drawers, launcher, and overflow checks passed");
} finally {
  await browser.close();
  server.stop();
}
