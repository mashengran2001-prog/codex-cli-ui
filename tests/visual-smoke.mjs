import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPopulatedPage, launchBrowser, root, startPreview } from "./browser-harness.mjs";

const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const server = await startPreview(4323);
const browser = await launchBrowser();

try {
  const desktop = await createPopulatedPage(browser, server.url, { width: 1380, height: 880 });
  await desktop.page.screenshot({ path: join(artifacts, "codex-ui-desktop.png"), fullPage: true });
  const desktopMetrics = await desktop.page.evaluate(() => {
    const composer = document.querySelector(".composer").getBoundingClientRect();
    const sidebar = document.querySelector(".chat-side-panel").getBoundingClientRect();
    const actions = document.querySelector(".terminal-actions").getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    return {
      composer, sidebar, body, titlebarReserve: window.innerWidth - actions.right, text: document.body.innerText.length,
      nebulaShells: document.querySelectorAll(".terminal-workspace").length,
      legacyHeaders: document.querySelectorAll(".sidebar-header, .brand-lockup").length,
    };
  });
  assert.ok(desktopMetrics.composer.width > 600);
  assert.ok(desktopMetrics.sidebar.width >= 226 && desktopMetrics.sidebar.width <= 234, "sidebar default width should match Nebula SIDEBAR_W_LOGICAL=230");
  assert.ok(desktopMetrics.titlebarReserve >= 150, "workspace actions entered the Windows titlebar controls area");
  assert.ok(desktopMetrics.text > 150);
  assert.equal(desktopMetrics.nebulaShells, 1);
  assert.equal(desktopMetrics.legacyHeaders, 0);
  await desktop.page.getByRole("tab", { name: "终端" }).click();
  await desktop.page.locator(".xterm-screen").waitFor();
  await desktop.page.getByRole("button", { name: "文件", exact: true }).click();
  await desktop.page.getByText("README.md").waitFor();
  await desktop.page.screenshot({ path: join(artifacts, "codex-ui-terminal.png"), fullPage: true });
  const terminalMetrics = await desktop.page.evaluate(() => {
    const terminal = document.querySelector(".terminal-workspace").getBoundingClientRect();
    const canvas = document.querySelector(".terminal-canvas").getBoundingClientRect();
    const drawer = document.querySelector(".terminal-drawer").getBoundingClientRect();
    const brandIcons = [...document.querySelectorAll(".cli-tool-list .brand-icon")].map((icon) => icon.getBoundingClientRect());
    return { terminal, canvas, drawer, brandIcons, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  assert.ok(terminalMetrics.terminal.width > 700);
  assert.ok(terminalMetrics.canvas.height > 500);
  assert.ok(terminalMetrics.drawer.width >= 296 && terminalMetrics.drawer.width <= 304, "drawer default width should match Nebula PANEL_W_LOGICAL=300");
  assert.equal(terminalMetrics.brandIcons.length, 2);
  assert.ok(terminalMetrics.brandIcons.every((icon) => icon.width <= 16 && icon.height <= 16));
  assert.ok(terminalMetrics.overflow <= 1);
  await desktop.page.getByRole("button", { name: "关闭文件面板" }).click();
  await desktop.page.locator(".terminal-actions").getByTitle("更多操作").click(); await desktop.page.getByRole("menuitem", { name: "打开设置" }).click();
  await desktop.page.locator(".terminal-settings").waitFor();
  await desktop.page.getByLabel("界面语言").selectOption("en-US");
  await desktop.page.getByRole("heading", { name: "Appearance" }).waitFor();
  await desktop.page.screenshot({ path: join(artifacts, "codex-ui-settings-en.png"), fullPage: true });
  assert.equal(await desktop.page.locator("html").getAttribute("lang"), "en-US");
  await desktop.page.getByLabel("Interface language").selectOption("zh-CN");
  await desktop.page.getByRole("heading", { name: "外观" }).waitFor();
  await desktop.page.screenshot({ path: join(artifacts, "codex-ui-settings.png"), fullPage: true });
  const settingsMetrics = await desktop.page.evaluate(() => {
    const settings = document.querySelector(".terminal-settings").getBoundingClientRect();
    const nav = document.querySelector(".settings-nav").getBoundingClientRect();
    const navItem = document.querySelector(".settings-nav button").getBoundingClientRect();
    const header = document.querySelector(".settings-header").getBoundingClientRect();
    const row = document.querySelector(".settings-row:not(.color-picker-row)").getBoundingClientRect();
    return {
      settings,
      navWidth: nav.width,
      navItemHeight: navItem.height,
      headerHeight: header.height,
      rowHeight: row.height,
      groupDividers: document.querySelectorAll(".settings-group-divider").length,
      splitButtons: [...document.querySelectorAll("button")].filter((button) => button.title === "向右拆分").length,
      filesButtons: [...document.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label") === "文件").length,
      sidePanels: document.querySelectorAll(".terminal-side-panel").length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(settingsMetrics.settings.width > 600);
  assert.ok(settingsMetrics.navWidth >= 192 && settingsMetrics.navWidth <= 200);
  assert.ok(settingsMetrics.navItemHeight >= 30 && settingsMetrics.navItemHeight <= 34);
  assert.ok(settingsMetrics.headerHeight >= 68 && settingsMetrics.headerHeight <= 76);
  assert.ok(settingsMetrics.rowHeight >= 42 && settingsMetrics.rowHeight <= 46);
  assert.ok(settingsMetrics.groupDividers >= 6);
  assert.equal(settingsMetrics.splitButtons, 0);
  assert.equal(settingsMetrics.filesButtons, 0);
  assert.equal(settingsMetrics.sidePanels, 0);
  assert.ok(settingsMetrics.overflow <= 1);
  await desktop.page.getByLabel("CLI 活动同步").scrollIntoViewIfNeeded();
  await desktop.page.screenshot({ path: join(artifacts, "codex-ui-settings-lifecycle.png"), fullPage: true });
  const lifecycleMetrics = await desktop.page.locator(".cli-lifecycle-setting").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, width: bounds.width, viewport: window.innerHeight };
  });
  assert.ok(lifecycleMetrics.top >= 0 && lifecycleMetrics.bottom <= lifecycleMetrics.viewport);
  assert.ok(lifecycleMetrics.width > 500);
  await desktop.context.close();

  const compact = await createPopulatedPage(browser, server.url, { width: 800, height: 720 });
  await compact.page.screenshot({ path: join(artifacts, "codex-ui-compact.png"), fullPage: true });
  const compactMetrics = await compact.page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const toolbar = document.querySelector(".composer-toolbar").getBoundingClientRect();
    const send = document.querySelector(".send-button").getBoundingClientRect();
    const options = document.querySelector(".composer-options").getBoundingClientRect();
    const actions = document.querySelector(".terminal-actions").getBoundingClientRect();
    return {
      overflow: shell.scrollWidth - shell.clientWidth,
      toolbarHeight: toolbar.height,
      sendLeft: send.left,
      optionsRight: options.right,
      titlebarReserve: window.innerWidth - actions.right,
      sendVisible: send.right <= window.innerWidth && send.left >= 0,
    };
  });
  assert.ok(compactMetrics.overflow <= 1, `compact layout overflowed by ${compactMetrics.overflow}px`);
  assert.ok(compactMetrics.toolbarHeight >= 40);
  assert.ok(compactMetrics.titlebarReserve >= 150, "compact workspace actions entered the Windows titlebar controls area");
  assert.ok(compactMetrics.sendVisible);
  assert.ok(compactMetrics.optionsRight <= compactMetrics.sendLeft + 1, "composer controls overlap send button");
  await compact.page.getByRole("tab", { name: "终端" }).click();
  await compact.page.locator(".xterm-screen").waitFor();
  await compact.page.getByRole("button", { name: "文件", exact: true }).click();
  await compact.page.getByText("README.md").waitFor();
  await compact.page.screenshot({ path: join(artifacts, "codex-ui-terminal-compact.png"), fullPage: true });
  const compactTerminalMetrics = await compact.page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const header = document.querySelector(".terminal-header").getBoundingClientRect();
    const tabs = document.querySelector(".terminal-side-panel").getBoundingClientRect();
    const drawer = document.querySelector(".terminal-drawer").getBoundingClientRect();
    const topTabs = document.querySelector(".terminal-top-tabs")?.getBoundingClientRect();
    const firstTab = document.querySelector(".terminal-top-tab")?.getBoundingClientRect();
    return {
      overflow: shell.scrollWidth - shell.clientWidth,
      headerHeight: header.height,
      tabsHeight: tabs.height,
      drawerInside: drawer.right <= window.innerWidth && drawer.left >= 0,
      topTabBottomAlign: topTabs ? Math.abs(topTabs.bottom - header.bottom) <= 1 : null,
      firstTabLeft: firstTab ? firstTab.left : null,
    };
  });
  assert.ok(compactTerminalMetrics.overflow <= 1, `compact terminal overflowed by ${compactTerminalMetrics.overflow}px`);
  assert.ok(compactTerminalMetrics.headerHeight >= 44 && compactTerminalMetrics.headerHeight <= 56, `Nebula title bar should be 48px, got ${compactTerminalMetrics.headerHeight}`);
  assert.ok(compactTerminalMetrics.tabsHeight >= 34);
  assert.ok(compactTerminalMetrics.drawerInside);
  assert.ok(compactTerminalMetrics.topTabBottomAlign === true, "top tabs must sit on the title bar bottom edge");
  assert.ok(compactTerminalMetrics.firstTabLeft !== null && compactTerminalMetrics.firstTabLeft >= 7 && compactTerminalMetrics.firstTabLeft <= 10, `first top tab must align with the 8px card inset, got left ${compactTerminalMetrics.firstTabLeft}`);
  await compact.context.close();
  console.log("visual-smoke: desktop and 800px layouts passed");
} finally {
  await browser.close();
  server.stop();
}
