const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.145.0-test\n");
  process.exit(0);
}

if (!args.includes("exec")) {
  process.stderr.write(`Unsupported fake Codex invocation: ${args.join(" ")}\n`);
  process.exit(2);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
const run = async () => {
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  send({ type: "thread.started", thread_id: "33333333-3333-4333-8333-333333333333" });
  send({ type: "turn.started" });
  send({ type: "item.started", item: { id: "command-1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  send({ type: "item.completed", item: { id: "command-1", type: "command_execution", command: "npm test", aggregated_output: "18 tests passed", status: "completed" } });
  send({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: `Completed from fake Codex: ${prompt.trim()}` } });
  send({ type: "turn.completed", usage: { input_tokens: 42, output_tokens: 17 } });
};

await run();
