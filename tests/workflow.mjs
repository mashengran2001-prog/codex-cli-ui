import assert from "node:assert/strict";
import { createPopulatedPage, launchBrowser, startPreview } from "./browser-harness.mjs";

const server = await startPreview(4322);
const browser = await launchBrowser();

try {
  const { context, page } = await createPopulatedPage(browser, server.url);
  assert.equal(await page.locator(".project-label strong").textContent(), "atlas-workspace");
  assert.match(await page.locator(".composer-status").textContent(), /Thread 11111111/);
  assert.match(await page.locator(".activity-row").textContent(), /npm test/);
  assert.match(await page.locator(".markdown-body").textContent(), /12 tests/);

  const request = await page.evaluate(() => window.__mock.lastRun);
  assert.equal(request.cwd, "F:\\demo\\atlas-workspace");
  assert.equal(request.sandboxMode, "workspace-write");
  assert.equal(request.reasoningEffort, "medium");
  assert.equal(request.prompt, "Fix the parser and run the test suite");

  await page.locator("textarea").fill("/");
  await page.getByRole("button", { name: /\/review/ }).waitFor();
  assert.equal(await page.locator(".command-menu button").count(), 4);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "启用" }).click();
  await page.getByText(/codex 打开此界面/).waitFor();
  assert.equal(await page.evaluate(() => window.__mock.launcherInstalled), true);

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    app: document.querySelector(".app-shell").scrollWidth - document.querySelector(".app-shell").clientWidth,
  }));
  assert.ok(overflow.document <= 1, `document overflowed by ${overflow.document}px`);
  assert.ok(overflow.app <= 1, `app overflowed by ${overflow.app}px`);
  await context.close();
  console.log("workflow: project, run stream, command menu, launcher, and overflow checks passed");
} finally {
  await browser.close();
  server.stop();
}
