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
  // 响铃时分屏工具栏闪烁（bell flash 指示）
  await page.locator(".pane-toolbar.bell-flash").waitFor();
  await page.getByText("需要处理").waitFor();
  await page.locator(".terminal-notice").click();
  await page.getByRole("button", { name: "命令面板" }).click();
  await page.getByText("工作目录", { exact: false }).waitFor();
  await page.locator(".command-palette").getByRole("button", { name: "复制路径", exact: true }).click();
  await page.getByRole("button", { name: "命令面板" }).click();
  assert.equal(await page.locator(".palette-list section").first().locator("h3").textContent(), "最近使用");
  assert.match(await page.locator(".palette-list section").first().locator("button").first().textContent(), /复制路径/);
  await page.keyboard.press("Escape");
  await page.locator(".terminal-actions").getByRole("button", { name: "向右拆分" }).click();
  await page.locator(".xterm-screen").nth(1).waitFor();
  assert.equal(await page.locator(".terminal-pane-leaf").count(), 2);
  assert.equal(await page.locator('.terminal-pane-shell[data-active="true"]').count(), 1);

  await page.locator(".terminal-pane-leaf").nth(1).getByRole("button", { name: "关闭分屏" }).click();
  assert.equal(await page.locator(".terminal-pane-leaf").count(), 1);

  // 每个分屏的工具栏可独立拆分（此分屏向下拆分）
  await page.locator(".terminal-pane-leaf").first().getByRole("button", { name: "向下拆分此分屏" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".terminal-pane-leaf").length === 2);
  assert.equal(await page.locator(".pane-divider.rows").count(), 1);

  // 拖拽分隔条调整分屏大小，尺寸写入分屏树并持久化到 localStorage
  const dividerBox = await page.locator(".pane-divider.rows").boundingBox();
  assert.ok(dividerBox && dividerBox.width > 2 && dividerBox.height >= 4, "divider should have a grab area");
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 90, { steps: 8 });
  await page.mouse.up();
  const slotStyle = await page.locator(".terminal-pane-split.rows > .pane-slot").first().getAttribute("style");
  assert.match(slotStyle ?? "", /0 1 \d+(?:\.\d+)?%/);
  await page.waitForFunction(() => {
    const layout = JSON.parse(localStorage.getItem("codex-cli-ui:terminal-layout-v5") || "{}");
    const sizes = layout.tree?.sizes;
    return Array.isArray(sizes) && sizes.length === 2 && Math.abs(sizes[0] + sizes[1] - 100) < 0.6;
  });

  // 快捷键：向下分屏（Ctrl+Shift+E）与分屏焦点切换（Ctrl+Alt+←/→）
  await page.keyboard.press("Control+Shift+E");
  await page.waitForFunction(() => document.querySelectorAll(".terminal-pane-leaf").length === 3);
  const activePaneId = () => page.evaluate(() => document.querySelector('.terminal-pane-shell[data-active="true"]')?.closest(".terminal-pane-leaf")?.dataset.sessionId ?? "");
  assert.ok(await activePaneId());
  const activeAfterSplit = await activePaneId();
  await page.keyboard.press("Control+Alt+ArrowRight");
  await page.waitForFunction((previous) => document.querySelector('.terminal-pane-shell[data-active="true"]')?.closest(".terminal-pane-leaf")?.dataset.sessionId !== previous, activeAfterSplit);
  const activeAfterNext = await activePaneId();
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await page.waitForFunction((previous) => document.querySelector('.terminal-pane-shell[data-active="true"]')?.closest(".terminal-pane-leaf")?.dataset.sessionId !== previous, activeAfterNext);

  // 收回多余分屏，恢复单 pane，后续用例保持原布局假设
  await page.locator(".terminal-pane-leaf").nth(1).getByRole("button", { name: "关闭分屏" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".terminal-pane-leaf").length === 2);
  await page.locator(".terminal-pane-leaf").nth(1).getByRole("button", { name: "关闭分屏" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".terminal-pane-leaf").length === 1);
  const secondSessionId = await page.evaluate(() => window.__mock.terminalSessions[1].id);
  const secondTab = page.locator(`.terminal-top-tab[data-session-id="${secondSessionId}"]`);
  await secondTab.locator(".terminal-tab-main").click();
  await page.waitForFunction((id) => document.querySelector(".terminal-pane-leaf")?.dataset.sessionId === id, secondSessionId);

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
  assert.equal(await page.getByLabel("恢复时自动接续 AI 对话").isChecked(), true);
  await page.getByLabel("恢复时自动接续 AI 对话").uncheck();
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).resumeAiSessions, false);
  await page.getByLabel("恢复时自动接续 AI 对话").check();
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).resumeAiSessions, true);

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
  // 补全样式与字符宽度：选择弹窗候选与宽松并断言持久化
  await page.getByLabel("补全样式").selectOption("popup");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).completionStyle, "popup");
  await page.getByLabel("字符宽度").selectOption("relaxed");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).cellWidth, "relaxed");
  // 新标签位置：切换为追加到末尾并断言持久化
  await page.getByLabel("新标签页位置").selectOption("end");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).newTabPlacement, "end");
  // 字体族：输入自定义字体链并断言持久化，再清空恢复默认
  await page.getByLabel("字体族").fill("JetBrains Mono, Consolas");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).fontFamily, "JetBrains Mono, Consolas");
  await page.getByLabel("字体族").fill("");
  assert.equal((await page.evaluate(() => window.codex.getAppSettings())).fontFamily, "");
  await page.getByRole("button", { name: "返回工作台" }).click();

  // 弹窗补全：输入命令后弹出候选列表；Tab 接受、Esc 关闭
  await page.locator(".command-dock input").fill("npm run");
  await page.locator(".completion-popup").waitFor();
  assert.equal(await page.locator(".completion-popup button").count(), 2);
  assert.match(await page.locator(".completion-popup").textContent(), /历史/);
  assert.match(await page.locator(".completion-popup").textContent(), /命令/);
  // Tab 接受高亮候选（默认首个）；再验证方向键切换候选
  await page.locator(".command-dock input").press("Tab");
  assert.equal(await page.locator(".command-dock input").inputValue(), "npm run --help");
  await page.locator(".command-dock input").fill("npm run");
  await page.locator(".completion-popup").waitFor();
  await page.locator(".command-dock input").press("ArrowDown");
  await page.locator(".command-dock input").press("Tab");
  assert.equal(await page.locator(".command-dock input").inputValue(), "npm run.ps1");
  await page.locator(".command-dock input").press("Escape");
  await page.locator(".command-dock input").fill("");
  // 恢复默认补全样式与字符宽度，避免影响后续用例
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".terminal-settings").waitFor();
  await page.getByLabel("补全样式").selectOption("inline");
  await page.getByLabel("字符宽度").selectOption("compact");
  await page.getByRole("button", { name: "返回工作台" }).click();

  // 拖拽标签到分屏左缘：dock 为左右分屏并持久化分屏树
  const beforeDockTabs = await page.locator(".terminal-top-tab").count();
  // 新建两个终端，再把第一个会话放回 pane，让最后一个会话保持“未分配”作为拖拽源
  await page.locator(".terminal-side-panel").getByRole("button", { name: "新建终端" }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll(".terminal-top-tab").length === count + 1, beforeDockTabs);
  await page.locator(".terminal-side-panel").getByRole("button", { name: "新建终端" }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll(".terminal-top-tab").length === count + 2, beforeDockTabs);
  const firstSessionId = await page.locator(".terminal-top-tab").first().getAttribute("data-session-id");
  await page.locator(".terminal-top-tab").nth(0).locator(".terminal-tab-main").click();
  await page.waitForFunction((sessionId) => document.querySelector(".terminal-pane-leaf")?.getAttribute("data-session-id") === sessionId, firstSessionId);
  const dockSourceId = await page.locator(".terminal-top-tab").last().getAttribute("data-session-id");
  const dockTargetId = await page.locator(".terminal-pane-leaf").first().getAttribute("data-session-id");
  assert.notEqual(dockSourceId, dockTargetId, "拖拽源应不同于 pane 会话，否则属于自拖");
  const dockSource = page.locator(`.terminal-top-tab[data-session-id="${dockSourceId}"]`);
  const dockTarget = page.locator(`.terminal-pane-leaf[data-session-id="${dockTargetId}"]`);
  await dockTarget.waitFor();
  const dockLeafCountBefore = await page.locator(".terminal-pane-leaf").count();
  // 用 CDP 派发受信拖拽事件：按住标签 → 拖到目标 pane 左缘中部 → 松开触发 dock
  // （React 19 会忽略合成 DragEvent，必须走受信事件流）
  const cdp = await context.newCDPSession(page);
  const dockSourceBox = await dockSource.boundingBox();
  const dockTargetBox = await dockTarget.boundingBox();
  assert.ok(dockSourceBox && dockTargetBox, "dock 拖拽起点/目标可用");
  const dockStartX = dockSourceBox.x + dockSourceBox.width * 0.3;
  const dockStartY = dockSourceBox.y + dockSourceBox.height / 2;
  const dockDropX = dockTargetBox.x + 2;
  const dockDropY = dockTargetBox.y + 34 + (dockTargetBox.height - 34) * 0.5;
  const dockDragData = { items: [{ mimeType: "text/terminal-session", data: dockSourceId }], dragOperationsMask: 1 | 2 | 16 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dockStartX, y: dockStartY, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dockStartX + 10, y: dockStartY + 6, button: "left", buttons: 1 });
  await page.waitForTimeout(120);
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: dockDropX, y: dockDropY, data: dockDragData });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: dockDropX, y: dockDropY, data: dockDragData });
  await page.locator(".dock-overlay").waitFor();
  await page.waitForFunction((targetId) => document.querySelector(`.terminal-pane-leaf[data-session-id="${targetId}"]`)?.classList.contains("dock-left"), dockTargetId);
  await page.waitForTimeout(150);
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x: dockDropX, y: dockDropY, data: dockDragData });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dockDropX, y: dockDropY, button: "left", clickCount: 1 });
  await page.waitForFunction((count) => document.querySelectorAll(".terminal-pane-leaf").length === count + 1, dockLeafCountBefore);
  const dockedTree = await page.evaluate(() => JSON.parse(localStorage.getItem("codex-cli-ui:terminal-layout-v5") || "{}").tree ?? null);
  assert.equal(dockedTree?.type === "split" && dockedTree.direction === "columns" ? dockedTree.children[0].sessionId : null, dockSourceId);
  // 收回分屏，后续用例保持单 pane 布局假设
  await page.locator(".terminal-pane-leaf").nth(1).getByRole("button", { name: "关闭分屏" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".terminal-pane-leaf").length === 1);

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
  // DocumentViewer 本地与远程图片渲染
  const localImg = page.locator('.document-content img[src^="data:image/png"]');
  await localImg.waitFor();
  assert.ok(await localImg.evaluate((img) => img.complete && img.naturalWidth > 0));
  const remoteImg = page.locator('.document-content img[src="https://example.com/banner.png"]');
  await remoteImg.waitFor();
  assert.equal(await remoteImg.getAttribute("src"), "https://example.com/banner.png");
  // 验证 readDocumentImage 被调用且 root 参数正确
  assert.equal(await page.evaluate(() => {
    const logs = window.__mock.$$callLog?.readDocumentImage || [];
    return logs.length > 0;
  }), true);
  const callLog = await page.evaluate(() => (window.__mock.$$callLog?.readDocumentImage || [])[0]);
  assert.ok(callLog?.args?.[0]?.endsWith("atlas-workspace"), `root should end with atlas-workspace, got ${callLog?.args?.[0]}`);
  const readDocLog = await page.evaluate(() => (window.__mock.$$callLog?.readDocument || [])[0]);
  assert.ok(readDocLog?.args?.[0]?.endsWith("atlas-workspace"), `readDocument root should end with atlas-workspace, got ${readDocLog?.args?.[0]}`);
 await page.getByRole("button", { name: "关闭文档" }).click();
  await page.getByRole("button", { name: "Git 状态" }).click();
  await page.getByText("src/App.tsx").waitFor();
  // 常用目录面板：frecency 历史 + 收藏 + 跳转 / 新建终端 / 移除历史
  await page.getByRole("button", { name: "常用目录", exact: true }).click();
  await page.locator(".directories-row", { hasText: "docs" }).waitFor();
  assert.equal(await page.locator(".directories-row").count(), 2);
  assert.match(await page.locator(".directories-row").first().textContent() ?? "", /atlas-workspace/);
  const docsRow = page.locator(".directories-row", { hasText: "docs" });
  await docsRow.locator(".directories-jump").click();
  await page.waitForFunction(() => window.__mock.terminalWrites.some((write) => String(write.data).startsWith("Set-Location -LiteralPath 'F:\\demo\\docs'")));
  await docsRow.locator(".drawer-row-actions button").nth(1).click();
  await page.waitForFunction(() => window.__mock.directoryEntries.find((entry) => entry.path === "F:\\demo\\docs")?.pinned === true);
  await docsRow.locator(".drawer-row-actions button").nth(1).click();
  await page.waitForFunction(() => window.__mock.directoryEntries.find((entry) => entry.path === "F:\\demo\\docs")?.pinned === false);
  const terminalCountBefore = await page.evaluate(() => window.__mock.terminalSessions.length);
  await docsRow.locator(".drawer-row-actions button").first().click();
  await page.waitForFunction((count) => window.__mock.terminalSessions.length === count + 1, terminalCountBefore);
  assert.equal(await page.evaluate(() => window.__mock.terminalSessions.at(-1).cwd), "F:\\demo\\docs");
  await docsRow.locator(".drawer-row-actions button").nth(2).click();
  await page.waitForFunction(() => !window.__mock.directoryEntries.some((entry) => entry.path === "F:\\demo\\docs"));
  assert.equal(await page.locator(".directories-row").count(), 1);
  await page.getByRole("button", { name: "关闭常用目录面板" }).click();
  // 剪贴板截图粘贴：剪贴板无文本但有图片时，粘贴本地 PNG 的引号路径
  await page.evaluate(() => { window.__mock.clipboardImage = "F:\\demo\\clipboard.png"; });
  await page.locator(".terminal-pane-leaf").first().locator(".xterm-screen").click();
  await page.keyboard.press("Control+v");
  await page.waitForFunction(() => window.__mock.terminalWrites.some((write) => write.data === "'F:\\demo\\clipboard.png'"));
  await page.evaluate(() => { window.__mock.clipboardImage = null; });
  // SSH 截图粘贴：SSH 会话粘贴时应把 sshProfileId 传给 bridge，远端图片路径写入终端
  await page.evaluate(() => { window.__mock.clipboardImage = "/tmp/codex-ui-paste-123.png"; });
  await page.getByTitle("连接 Dev server").click();
  await page.waitForFunction(() => window.__mock.terminalSessions.some((session) => session.kind === "ssh"));
  await page.locator(".terminal-pane-shell").last().locator(".xterm-screen").click();
  await page.keyboard.press("Control+v");
  await page.waitForFunction(() => window.__mock.terminalWrites.some((write) => String(write.data).includes("codex-ui-paste-123.png")));
  assert.equal(await page.evaluate(() => window.__mock.lastPasteProfileId), "ssh-mock");
  // SSH pane 退出后出现重试按钮，点击后旧会话关闭并重建 SSH 会话
  const sshSessionId = await page.evaluate(() => {
    const session = window.__mock.terminalSessions.find((item) => item.kind === "ssh");
    const sessionId = session.id;
    window.__mock.terminalListeners.forEach((listener) => listener({ sessionId, type: "exit", code: 1 }));
    return sessionId;
  });
  const sshRetry = page.locator(`.terminal-pane-leaf[data-session-id="${sshSessionId}"] .pane-retry`);
  await sshRetry.waitFor();
  assert.equal(await sshRetry.getAttribute("aria-label"), "重试 SSH 连接");
  await sshRetry.click();
  // restartSsh 会删除旧会话再创建新会话，总量不变，等旧会话被移除且新 SSH 会话出现
  await page.waitForFunction((oldId) => {
    const sessions = window.__mock.terminalSessions;
    const oldGone = !sessions.some((item) => item.id === oldId);
    const newSsh = sessions.some((item) => item.kind === "ssh" && item.id !== oldId);
    return oldGone && newSsh;
  }, sshSessionId);
  assert.ok(!(await page.evaluate((id) => window.__mock.terminalSessions.some((item) => item.id === id), sshSessionId)), "old SSH session should be closed");
  assert.equal(await page.evaluate(() => window.__mock.terminalSessions.at(-1).kind), "ssh");
  // 活动 SSH pane 时文件面板跟随为 SFTP
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".sftp-drawer").waitFor();
  await page.getByText("remote.txt").waitFor();
  await page.getByRole("button", { name: "关闭 SFTP 面板" }).click();
  // AI 会话恢复与分叉：meta 事件写入 aiSource/aiSessionId 后，标签右键菜单出现两个入口
  const aiSessionId = await page.evaluate(() => {
    const sessionId = window.__mock.terminalSessions[0].id;
    window.__mock.terminalListeners.forEach((listener) => listener({
      sessionId,
      type: "meta",
      terminal: { ...window.__mock.terminalSessions[0], aiSource: "codex", aiSessionId: "run_9f2c1b" },
    }));
    return sessionId;
  });
  const aiTab = page.locator(".terminal-top-tab").first();
  await aiTab.click({ button: "right" });
  await page.getByRole("button", { name: "继续上次 AI 会话" }).waitFor();
  await page.getByRole("button", { name: "继续上次 AI 会话" }).click();
  assert.equal(await page.evaluate(() => window.__mock.lastResumeId), aiSessionId);
  await aiTab.click({ button: "right" });
  await page.getByRole("button", { name: "分叉 AI 会话" }).waitFor();
  const forkTabCount = await page.locator(".terminal-top-tab").count();
  await page.getByRole("button", { name: "分叉 AI 会话" }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".terminal-top-tab").length === count + 1, forkTabCount);
  assert.equal((await page.evaluate(() => window.__mock.lastFork)).sessionId, aiSessionId);
  await page.evaluate(() => { window.__mock.clipboardImage = null; });
  await page.getByRole("tab", { name: "对话" }).click();
  await page.locator(".composer textarea").waitFor();

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    app: document.querySelector(".app-shell").scrollWidth - document.querySelector(".app-shell").clientWidth,
  }));
  assert.ok(overflow.document <= 1, `document overflowed by ${overflow.document}px`);
  assert.ok(overflow.app <= 1, `app overflowed by ${overflow.app}px`);

  // SVN 抽屉：标题/版本、更新按钮替代拉取/推送、revert 需先选择文件
  await page.getByRole("tab", { name: "终端" }).click();
  await page.locator(".xterm-screen").first().waitFor();
  await page.evaluate(() => { window.__mock.svnMode = true; });
  await page.getByRole("button", { name: "Git 状态" }).click();
  const svnDrawer = page.locator(".git-drawer");
  await svnDrawer.waitFor();
  assert.equal(await svnDrawer.locator(".drawer-heading strong").textContent(), "SVN");
  assert.match(await svnDrawer.locator(".drawer-heading").textContent() ?? "", /r124/);
  assert.match(await svnDrawer.locator(".git-summary").textContent() ?? "", /版本 124/);
  assert.equal(await svnDrawer.locator(".git-summary button[title='更新']").count(), 1);
  assert.equal(await svnDrawer.locator(".git-summary button[title='拉取（仅快进）']").count(), 0);
  assert.equal(await svnDrawer.locator(".git-summary button[title='推送']").count(), 0);
  const svnUnstage = svnDrawer.locator(".git-actions button", { hasText: "取消暂存" });
  assert.equal(await svnUnstage.isDisabled(), true);
  await svnDrawer.locator(".git-row", { hasText: "src/App.tsx" }).click();
  assert.equal(await svnUnstage.isDisabled(), false);
  await svnUnstage.click();
  await page.waitForFunction(() => window.__mock.lastGitAction?.action === "unstage");
  assert.deepEqual(await page.evaluate(() => window.__mock.lastGitAction.paths), ["src/App.tsx"]);
  await svnDrawer.locator(".git-summary button[title='更新']").click();
  await page.waitForFunction(() => window.__mock.lastGitAction?.action === "update");
  assert.deepEqual(await page.evaluate(() => window.__mock.lastGitAction.paths), []);
  await svnDrawer.getByTitle("关闭 Git 面板").click();
  await page.evaluate(() => { window.__mock.svnMode = false; });

  // 分屏树身份恢复：预置 v5 布局（leaves 携带 cwd/shell 身份），重载后按身份重建分屏
  await page.evaluate(() => {
    localStorage.setItem("codex-cli-ui:terminal-layout-v5", JSON.stringify({
      tree: { type: "split", direction: "columns", children: [{ type: "leaf", sessionId: "old-a" }, { type: "leaf", sessionId: "old-b" }] },
      activeSessionId: "old-a",
      sidebarWidth: 260, drawerWidth: 280, sidebarCollapsed: false, tabsCollapsed: false, toolsCollapsed: false, sshCollapsed: true,
      leaves: {
        "old-a": { cwd: "F:\\demo\\atlas-workspace", shellId: "powershell" },
        "old-b": { cwd: "F:\\demo\\docs", shellId: "powershell" },
      },
    }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "终端" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".terminal-pane-leaf").length === 2);
  const restoredCwds = await page.evaluate(() => window.__mock.terminalSessions.map((session) => session.cwd));
  assert.ok(restoredCwds.includes("F:\\demo\\atlas-workspace"), "restored atlas pane");
  assert.ok(restoredCwds.includes("F:\\demo\\docs"), "restored docs pane");
  await page.waitForFunction(() => {
    const leaves = JSON.parse(localStorage.getItem("codex-cli-ui:terminal-layout-v5") || "{}").leaves ?? {};
    return Object.keys(leaves).length === 2;
  });
  const savedLeafCwds = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("codex-cli-ui:terminal-layout-v5")).leaves).map((identity) => identity.cwd));
  assert.ok(savedLeafCwds.includes("F:\\demo\\atlas-workspace"));
  assert.ok(savedLeafCwds.includes("F:\\demo\\docs"));
  const restoredLeafIds = await page.evaluate(() => [...document.querySelectorAll(".terminal-pane-leaf")].map((leaf) => leaf.getAttribute("data-session-id")));
  assert.equal(restoredLeafIds.length, 2);
  assert.ok(!restoredLeafIds.includes("old-a") && !restoredLeafIds.includes("old-b"), "leaf ids replaced by rebuilt sessions");

  // WSL 文件面板：活动终端为 WSL 目录时，文件列表根目录跟随 WSL 路径
  await page.evaluate(() => {
    localStorage.removeItem("codex-cli-ui:terminal-layout-v5");
    localStorage.setItem("codex-cli-ui:test-wsl-terminal", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "终端" }).click();
  await page.waitForFunction(() => window.__mock.terminalSessions.some((session) => String(session.cwd).startsWith("\\\\wsl")));
  await page.locator(".terminal-top-tab", { hasText: "dev" }).locator(".terminal-tab-main").click();
  await page.waitForFunction(() => document.querySelector(".terminal-pane-leaf")?.dataset.sessionId === "33333333-3333-4333-8333-333333333333");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".file-row", { hasText: "README.md" }).waitFor();
  const wslReadmePath = await page.locator(".file-row", { hasText: "README.md" }).getAttribute("title");
  assert.equal(wslReadmePath, "\\\\wsl.localhost\\Ubuntu\\home\\dev\\README.md");
  await page.evaluate(() => localStorage.removeItem("codex-cli-ui:test-wsl-terminal"));

  await context.close();
  console.log("workflow: chat, Nebula terminal, drawers, launcher, overflow, SVN, split restore, and WSL checks passed");
} finally {
  await browser.close();
  server.stop();
}
