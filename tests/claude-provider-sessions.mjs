import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider } from "../dist-electron/electron/claude-provider.js";

// 本轮修复点：Claude provider 会话按“项目目录或其子目录”匹配，
// 让父级项目（如 F:\codex pro）能看到子目录里的 Claude 桌面版/CLI 会话。
const SESSION_ID = "59de8321-de7f-4b94-9939-fd63bfa4c813";
const FIXTURE_CWD = "F:\\codex pro\\fixture-sub\\work";
const PARENT_CWD = "F:\\codex pro";
const DESKTOP_ONLY_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const DESKTOP_ONLY_CWD = "F:\\codex pro\\desktop-only\\sub";
const OUTSIDE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OUTSIDE_CWD = "D:\\elsewhere";

const root = await mkdtemp(join(tmpdir(), "claude-provider-"));
const claudeConfig = join(root, "claude");
const desktopRoot = join(root, "desktop");
const oldConfig = process.env.CLAUDE_CONFIG_DIR;
const oldDesktop = process.env.CLAUDE_UI_DESKTOP_ROOT;

try {
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.CLAUDE_UI_DESKTOP_ROOT = desktopRoot;

  // CLI 会话 jsonl（Claude 桌面版 agent 会话同时会写 CLI 会话文件）
  const projectDir = join(claudeConfig, "projects", "F--codex-pro-fixture-sub-work");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), [
    JSON.stringify({ type: "user", sessionId: SESSION_ID, cwd: FIXTURE_CWD, timestamp: "2026-08-25T04:10:00.000Z", message: { role: "user", content: [{ type: "text", text: "继续工作" }] } }),
    JSON.stringify({ type: "assistant", sessionId: SESSION_ID, cwd: FIXTURE_CWD, timestamp: "2026-08-25T04:11:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的，正在处理" }] } }),
    JSON.stringify({ type: "summary", summary: "Phenology-time 线程任务续接" }),
    "",
  ].join("\n"), "utf8");

  // 父目录之外的会话，不应出现在列表里
  await mkdir(join(claudeConfig, "projects", "D--elsewhere"), { recursive: true });
  await writeFile(join(claudeConfig, "projects", "D--elsewhere", `${OUTSIDE_ID}.jsonl`),
    JSON.stringify({ type: "user", sessionId: OUTSIDE_ID, cwd: OUTSIDE_CWD, timestamp: "2026-08-25T04:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "外部会话" }] } }) + "\n", "utf8");

  // Claude 桌面版元数据：与 CLI 会话同 id（应去重，只出现一次）
  const desktopDir = join(desktopRoot, "d0f58821-99b7-428b-8445-910b097930af", "00000000-0000-4000-8000-000000000001");
  await mkdir(desktopDir, { recursive: true });
  await writeFile(join(desktopDir, "local_098366c5-a948-467d-b48f-b8994caa0eef.json"), JSON.stringify({
    sessionId: "local_098366c5-a948-467d-b48f-b8994caa0eef",
    cliSessionId: SESSION_ID,
    cwd: FIXTURE_CWD,
    createdAt: 1787630983886,
    lastActivityAt: 1787632459562,
    title: "Phenology-time 线程任务续接",
    isArchived: false,
  }), "utf8");

  // 仅桌面版元数据（无 CLI jsonl）的会话：应单独以 desktop 来源出现
  await mkdir(join(desktopRoot, "only-desktop", "00000000-0000-4000-8000-000000000002"), { recursive: true });
  await writeFile(join(desktopRoot, "only-desktop", "00000000-0000-4000-8000-000000000002", "local_11111111-2222-3333-4444-555555555555.json"), JSON.stringify({
    sessionId: "local_11111111-2222-3333-4444-555555555555",
    cliSessionId: DESKTOP_ONLY_ID,
    cwd: DESKTOP_ONLY_CWD,
    createdAt: 1787630980000,
    lastActivityAt: 1787632450000,
    title: "桌面版专属会话",
    isArchived: false,
  }), "utf8");

  const provider = new ClaudeProvider({ getCredential: async () => null, setCredential: async () => {} });

  // 1) 父项目目录应列出子目录会话（本轮修复）
  const parentSessions = await provider.listSessions(PARENT_CWD);
  const found = parentSessions.find((s) => s.id === SESSION_ID);
  assert.ok(found, `parent listing missing subdir session: ${JSON.stringify(parentSessions.map((s) => s.id))}`);
  assert.equal(found.cwd, FIXTURE_CWD);

  // 2) 纯桌面版会话以 desktop 来源出现
  const desktopOnly = parentSessions.find((s) => s.id === DESKTOP_ONLY_ID);
  assert.ok(desktopOnly, "desktop-only session missing from parent listing");
  assert.equal(desktopOnly.source, "desktop");
  assert.equal(desktopOnly.cliVersion, "Claude 桌面版");

  // 3) 同一会话只出现一次（CLI 与桌面元数据去重）
  assert.equal(parentSessions.filter((s) => s.id === SESSION_ID).length, 1);

  // 4) 非子目录会话不出现
  assert.ok(!parentSessions.some((s) => s.id === OUTSIDE_ID), "outside session leaked into parent listing");

  // 5) 精确目录下仍能列出
  const exactSessions = await provider.listSessions(FIXTURE_CWD);
  assert.ok(exactSessions.some((s) => s.id === SESSION_ID), "exact cwd listing missing session");

  // 6) 读取会话：会话自身 cwd 与父目录都能打开，且带消息
  const byExact = await provider.getSession(SESSION_ID, FIXTURE_CWD);
  assert.ok(byExact, "getSession exact cwd returned null");
  assert.equal(byExact.title, "Phenology-time 线程任务续接");
  assert.ok((byExact.messages ?? []).length >= 2, `expected >=2 messages, got ${byExact.messages?.length}`);
  assert.equal(byExact.messages?.[0].role, "user");
  assert.match(byExact.messages?.[0].content ?? "", /继续工作/);

  const byParent = await provider.getSession(SESSION_ID, PARENT_CWD);
  assert.ok(byParent, "getSession parent cwd returned null");
  assert.equal(byParent.id, SESSION_ID);

  // 7) 未知/外部会话在父目录下读取不到
  assert.equal(await provider.getSession(OUTSIDE_ID, PARENT_CWD), null);

  console.log("claude-provider-sessions: 子目录会话匹配/桌面来源/去重/读取全部通过");
} finally {
  process.env.CLAUDE_CONFIG_DIR = oldConfig;
  process.env.CLAUDE_UI_DESKTOP_ROOT = oldDesktop;
  await rm(root, { recursive: true, force: true });
}