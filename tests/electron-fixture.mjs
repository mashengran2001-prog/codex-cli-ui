import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createElectronFixture(root, codexHome) {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const sessionDirectory = join(codexHome, "sessions", "2026", "07", "29");
  await mkdir(sessionDirectory, { recursive: true });
  const lines = [
    { timestamp: "2026-07-29T02:00:00.000Z", type: "session_meta", payload: { id: sessionId, timestamp: "2026-07-29T02:00:00.000Z", cwd: root, cli_version: "0.145.0", model: "gpt-5.6-terra" } },
    { timestamp: "2026-07-29T02:00:01.000Z", type: "event_msg", payload: { type: "task_started", started_at: "2026-07-29T02:00:01.000Z" } },
    { timestamp: "2026-07-29T02:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "Inspect imported history" } },
    { timestamp: "2026-07-29T02:00:03.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "Checking the parser and its tests." } },
    { timestamp: "2026-07-29T02:00:04.000Z", type: "response_item", payload: { type: "function_call", id: "call-item", name: "shell_command", arguments: "{\"command\":\"npm test\"}", call_id: "call-1" } },
    { timestamp: "2026-07-29T02:00:05.000Z", type: "response_item", payload: { type: "function_call_output", id: "output-item", call_id: "call-1", output: "18 tests passed" } },
    { timestamp: "2026-07-29T02:00:06.000Z", type: "event_msg", payload: { type: "agent_message", message: "Imported response is ready." } },
    { timestamp: "2026-07-29T02:00:07.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Imported response is ready." } },
  ];
  await writeFile(join(sessionDirectory, `rollout-2026-07-29T02-00-00-${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  await writeFile(join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: sessionId, thread_name: "Imported session", updated_at: "2026-07-29T02:00:07.000Z" })}\n`, "utf8");
  return sessionId;
}

export function launcherArgs(root, prompt = "Fix the parser from CLI") {
  const cwd = Buffer.from(root, "utf8").toString("base64url");
  const args = Buffer.from(JSON.stringify([prompt]), "utf8").toString("base64url");
  return [`--codex-cwd-b64=${cwd}`, `--codex-args-b64=${args}`];
}
