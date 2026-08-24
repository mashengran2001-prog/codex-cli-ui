import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { createElectronFixture, launcherArgs } from "./electron-fixture.mjs";
import { root } from "./browser-harness.mjs";

const testRoot = join(root, ".tmp", "electron-visual");
const codexHome = join(testRoot, "codex-home");
const userData = join(testRoot, "user-data");
const artifacts = join(root, "artifacts");
await rm(testRoot, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
await createElectronFixture(root, codexHome);

const app = await electron.launch({
  executablePath: electronPath,
  args: [root, ...launcherArgs(root, "Review the renderer layout")],
  cwd: root,
  env: {
    ...process.env,
    CODEX_UI_CLI_PATH: process.execPath,
    CODEX_UI_CLI_PREFIX_ARGS: JSON.stringify([join(root, "tests", "fake-codex.mjs")]),
    CODEX_UI_CODEX_HOME: codexHome,
    CODEX_UI_USER_DATA_DIR: userData,
    TEMP: join(root, ".tmp"),
    TMP: join(root, ".tmp"),
  },
  timeout: 30_000,
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.locator("textarea").waitFor({ timeout: 15_000 });
  await window.locator(".send-button").click();
  await window.getByText(/Completed from fake Codex/).waitFor({ timeout: 15_000 });
  await window.screenshot({ path: join(artifacts, "codex-ui-electron.png") });
  const metrics = await window.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const composer = document.querySelector(".composer").getBoundingClientRect();
    return { overflow: shell.scrollWidth - shell.clientWidth, composerWidth: composer.width, bodyText: document.body.innerText.length };
  });
  assert.ok(metrics.overflow <= 1);
  assert.ok(metrics.composerWidth > 600);
  assert.ok(metrics.bodyText > 150);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 620));
  await window.waitForTimeout(250);
  await window.getByRole("tab", { name: "终端" }).click();
  await window.getByTitle("CLI 工具设置").click();
  await window.locator(".terminal-settings").waitFor();
  await window.getByLabel("标签栏位置").selectOption("top");
  await window.locator('.terminal-top-tab[data-tab-kind="settings"]').waitFor();
  await window.locator(".terminal-top-tab[data-session-id] .terminal-tab-main").first().click();
  await window.waitForFunction(() => document.querySelectorAll(".terminal-top-tabs").length === 1);
  await window.locator(".xterm-screen").waitFor({ timeout: 15_000 });
  const titlebarMetrics = await window.evaluate(() => {
    const actions = document.querySelector(".terminal-actions").getBoundingClientRect();
    const header = document.querySelector(".terminal-header").getBoundingClientRect();
    const topTabs = document.querySelector(".terminal-top-tabs")?.getBoundingClientRect();
    const firstTab = document.querySelector(".terminal-top-tab")?.getBoundingClientRect();
    return {
      reserve: window.innerWidth - actions.right,
      actionsLeft: actions.left,
      headerLeft: header.left,
      headerHeight: header.height,
      topTabBottomAlign: topTabs ? Math.abs(topTabs.bottom - header.bottom) <= 1 : null,
      firstTabLeft: firstTab ? firstTab.left : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(titlebarMetrics.reserve >= 150, "workspace actions entered the native Windows controls area");
  assert.ok(titlebarMetrics.actionsLeft >= titlebarMetrics.headerLeft);
  assert.ok(titlebarMetrics.overflow <= 1);
  assert.ok(titlebarMetrics.headerHeight >= 44 && titlebarMetrics.headerHeight <= 56, `Nebula title bar should be 48px, got ${titlebarMetrics.headerHeight}`);
  assert.ok(titlebarMetrics.topTabBottomAlign === true, "top tabs must sit on the title bar bottom edge");
  assert.ok(titlebarMetrics.firstTabLeft !== null && titlebarMetrics.firstTabLeft >= 7 && titlebarMetrics.firstTabLeft <= 10, `first top tab must align with the 8px card inset, got left ${titlebarMetrics.firstTabLeft}`);
  await window.screenshot({ path: join(artifacts, "codex-ui-electron-titlebar.png") });
  console.log("electron-visual: real Electron window screenshot and layout checks passed");
} finally {
  await app.close();
}
