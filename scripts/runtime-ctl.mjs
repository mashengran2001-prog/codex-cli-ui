#!/usr/bin/env node
// Runtime control CLI for codex-cli-ui (port of nebula ctl, cli.rs).
// Speaks the same JSON-line protocol as the runtime server in
// electron/runtime-control.ts. The endpoint is a per-user-data JSON file
// written by the running app; pass --endpoint to override (tests do this).

import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function endpointPath() {
  if (process.env.CODEX_UI_USER_DATA_DIR) return join(process.env.CODEX_UI_USER_DATA_DIR, "runtime-endpoint.json");
  return join(homedir(), ".codex-cli-ui", "runtime-endpoint.json");
}

function readEndpoint(flag) {
  const path = flag || endpointPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.port === "number" && typeof parsed.token === "string") return parsed;
  } catch (error) {
    if (process.env.CLI_TRACE) process.stderr.write("[cli] endpoint read failed: " + String(error?.message || error) + "\n");
  }
  return null;
}

function requestOnce(endpoint, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (process.env.CLI_TRACE) process.stderr.write("[cli] request " + method + " -> " + endpoint.port + "\n");
    const socket = connect({ port: endpoint.port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("runtime_no_response: the runtime did not answer in time"));
    }, timeoutMs);
    let buffer = "";
    socket.setNoDelay(true);
    socket.on("connect", () => { if (process.env.CLI_TRACE) process.stderr.write("[cli] connected\n");
      socket.write(JSON.stringify({ id: "cli-" + Date.now(), token: endpoint.token, method, params: params ?? {} }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n"); if (process.env.CLI_TRACE) process.stderr.write("[cli] data: " + chunk.length + " bytes, newline=" + newline + "\n");
      if (newline >= 0) {
        clearTimeout(timer);
        socket.end();
        const line = buffer.slice(0, newline);
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("invalid response from runtime"));
        }
      }
    });
    socket.on("error", (error) => { if (process.env.CLI_TRACE) process.stderr.write("[cli] error: " + error.message + "\n");
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => { if (process.env.CLI_TRACE) process.stderr.write("[cli] close\n");
      clearTimeout(timer);
      if (!buffer.includes("\n")) reject(new Error("runtime closed the connection without a response"));
    });
  });
}

function fail(message) {
  process.stderr.write("codex-ui-ctl: " + message + "\n");
  process.exit(1);
}

function printResponse(response, pretty) {
  const text = pretty ? JSON.stringify(response, null, 2) : JSON.stringify(response);
  process.stdout.write(text + "\n");
  if (response.ok) return 0;
  const error = response.error || {};
  process.stderr.write("codex-ui-ctl: " + (error.message || "runtime request failed") + " (" + (error.code || "runtime_error") + ")\n");
  return 1;
}

function usage() {
  process.stdout.write("codex-ui-ctl — runtime control for codex-cli-ui\n\n");
  process.stdout.write("Usage:\n");
  process.stdout.write("  codex-ui-ctl describe [--pretty]\n");
  process.stdout.write("  codex-ui-ctl snapshot [--pretty]\n");
  process.stdout.write("  codex-ui-ctl orchestrate --spec <json> | --file <path> [--pretty]\n");
  process.stdout.write("  codex-ui-ctl tab.new [--cwd <dir>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl window.create [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.focus --pane <id> [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.read --pane <id> [--lines <n>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.prompt --pane <id> --text <text> [--no-submit] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.run --pane <id> --command <command> [--no-wait] [--timeout-ms <n>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.split --pane <id> --direction <columns|rows> [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.procs --pane <id> [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.send_key --pane <id> --key <key> [--control] [--alt] [--shift] [--repeat <n>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl pane.wait --pane <id> --state <state> [--after-seq <n>] [--timeout-ms <n>] [--pretty]\n");  process.stdout.write("  codex-ui-ctl events.subscribe [--since-revision <n>] [--timeout-ms <n>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl agents.list [--window <id>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl agent.get --agent <name-or-id> [--generation <n>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl agent.start --name <name> --kind <claude|codex|...> [--cwd <dir> | --pane <id>] [--resume-session-id <id>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl agent.prompt --agent <name-or-id> --text <text> [--generation <n>] [--no-submit] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl agent.read --agent <name-or-id> [--generation <n>] [--lines <n>] [--pretty]\n");
  process.stdout.write("  codex-ui-ctl agent.wait --agent <name-or-id> --generation <n> --state <state> [--after-seq <n>] [--timeout-ms <n>] [--pretty]\n");  process.stdout.write("  codex-ui-ctl agent.fork --name <name> --kind <claude|codex|...> (--source-cwd <dir> | --source-pane <id>) [--resume-session-id <id>] [--branch <name>] [--base <rev>] [--path <dir>] [--allow-dirty-source] [--pretty]\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --endpoint <path>   override the runtime endpoint file\n");
  process.stdout.write("  --pretty            pretty-print the JSON response\n");
  process.stdout.write("  --help              show this help\n");
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--pretty") flags.pretty = true;
    else if (arg === "--no-submit") flags["no-submit"] = true;
    else if (arg === "--no-wait") flags["no-wait"] = true;
    else if (arg === "--allow-dirty-source") flags["allow-dirty-source"] = true;
    else if (arg === "--control") flags.control = true;
    else if (arg === "--alt") flags.alt = true;
    else if (arg === "--shift") flags.shift = true;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined) fail("missing value for " + arg);
      flags[arg.slice(2)] = value;
      i++;
    } else positional.push(arg);
  }
  return { flags, command: positional[0] };
}

async function main() {
  const { flags, command } = parseArgs(process.argv.slice(2));
  if (flags.help || !command) {
    usage();
    process.exit(command ? 0 : 1);
  }
  const timeoutMs = Number(flags["timeout-ms"] ?? 30000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) fail("--timeout-ms must be between 1 and 86400000");
  const endpoint = readEndpoint(flags.endpoint);
  if (!endpoint) fail("runtime_unavailable: no running codex-cli-ui runtime found (start the app first)");

  let params = {};
  let method = command;
  switch (command) {
    case "describe":
      method = "runtime.describe";
      break;
    case "snapshot":
      method = "runtime.snapshot";
      break;
    case "orchestrate": {
      const spec = flags.spec;
      const file = flags.file;
      if (spec && file) fail("exactly one of --spec or --file is required");
      let source;
      if (spec) source = spec;
      else if (file) {
        try {
          source = readFileSync(file, "utf8");
        } catch {
          fail("cannot read workflow file: " + file);
        }
      } else fail("exactly one of --spec or --file is required");
      try {
        params = JSON.parse(source);
      } catch (error) {
        fail("workflow is not valid JSON: " + error.message);
      }
      method = "runtime.orchestrate";
      break;
    }
    case "window.create":
      method = "window.create";
      break;
    case "tab.new":
      method = "tab.new";
      if (flags.cwd) params = { cwd: flags.cwd };
      break;
    case "pane.focus":
      method = "pane.focus";
      if (!flags.pane) fail("pane.focus requires --pane");
      params = { pane_id: flags.pane };
      break;
    case "pane.read":
      method = "pane.read";
      if (!flags.pane) fail("pane.read requires --pane");
      params = { pane_id: flags.pane };
      if (flags.lines) params.lines = Number(flags.lines);
      break;
    case "pane.prompt":
      method = "pane.prompt";
      if (!flags.pane) fail("pane.prompt requires --pane");
      if (flags.text === undefined) fail("pane.prompt requires --text");
      params = { pane_id: flags.pane, text: flags.text, submit: !flags["no-submit"] };
      break;
    case "pane.run":
      method = "pane.run";
      if (!flags.pane) fail("pane.run requires --pane");
      if (flags.command === undefined) fail("pane.run requires --command");
      params = { pane_id: flags.pane, command: flags.command, wait: !flags["no-wait"], timeout_ms: timeoutMs };
      break;
    case "pane.split":
      method = "pane.split";
      if (!flags.pane) fail("pane.split requires --pane");
      if (flags.direction !== "columns" && flags.direction !== "rows") fail("pane.split requires --direction columns|rows");
      params = { pane_id: flags.pane, direction: flags.direction };
      break;
    case "pane.procs":
      method = "pane.procs";
      if (!flags.pane) fail("pane.procs requires --pane");
      params = { pane_id: flags.pane };
      break;
    case "pane.send_key":
      method = "pane.send_key";
      if (!flags.pane) fail("pane.send_key requires --pane");
      if (!flags.key) fail("pane.send_key requires --key");
      params = { pane_id: flags.pane, key: flags.key, modifiers: { control: !!flags.control, alt: !!flags.alt, shift: !!flags.shift }, repeat: Number(flags.repeat ?? 1) };
      break;
    case "pane.wait":
      method = "pane.wait";
      if (!flags.pane) fail("pane.wait requires --pane");
      if (!flags.state) fail("pane.wait requires --state");
      params = { pane_id: flags.pane, state: flags.state, timeout_ms: timeoutMs };
      if (flags["after-seq"] !== undefined) params.after_seq = Number(flags["after-seq"]);
      break;
    case "events.subscribe":
      method = "events.subscribe";
      params = { timeout_ms: timeoutMs };
      if (flags["since-revision"] !== undefined) params.since_revision = Number(flags["since-revision"]);
      else if (flags["since-seq"] !== undefined) params.since_seq = Number(flags["since-seq"]);
      break;
    case "agents.list":
      method = "agents.list";
      if (flags.window !== undefined) params = { window_id: Number(flags.window) };
      break;
    case "agent.get":
      method = "agent.get";
      if (!flags.agent) fail("agent.get requires --agent");
      params = { agent: flags.agent };
      if (flags.generation !== undefined) params.generation = Number(flags.generation);
      break;
    case "agent.start":
      method = "agent.start";
      if (!flags.name) fail("agent.start requires --name");
      if (!flags.kind) fail("agent.start requires --kind");
      if (flags.cwd && flags.pane) fail("agent.start accepts either --cwd or --pane");
      params = { name: flags.name, kind: flags.kind, cwd: flags.cwd, pane_id: flags.pane, resume_session_id: flags["resume-session-id"] };
      break;
    case "agent.prompt":
      method = "agent.prompt";
      if (!flags.agent) fail("agent.prompt requires --agent");
      if (flags.text === undefined) fail("agent.prompt requires --text");
      params = { agent: flags.agent, text: flags.text, submit: !flags["no-submit"] };
      if (flags.generation !== undefined) params.generation = Number(flags.generation);
      break;
    case "agent.read":
      method = "agent.read";
      if (!flags.agent) fail("agent.read requires --agent");
      params = { agent: flags.agent, lines: Number(flags.lines ?? 100) };
      if (flags.generation !== undefined) params.generation = Number(flags.generation);
      break;
    case "agent.wait":
      method = "agent.wait";
      if (!flags.agent) fail("agent.wait requires --agent");
      if (flags.generation === undefined) fail("agent.wait requires --generation");
      if (!flags.state) fail("agent.wait requires --state");
      params = { agent: flags.agent, generation: Number(flags.generation), state: flags.state, timeout_ms: timeoutMs };
      if (flags["after-seq"] !== undefined) params.after_seq = Number(flags["after-seq"]);
      break;    case "agent.fork":
      method = "agent.fork";
      if (!flags.name) fail("agent.fork requires --name");
      if (!flags.kind) fail("agent.fork requires --kind");
      if (!flags["source-cwd"] && !flags["source-pane"]) fail("agent.fork requires --source-cwd or --source-pane");
      params = {
        name: flags.name,
        kind: flags.kind,
        resume_session_id: flags["resume-session-id"],
        source_pane: flags["source-pane"],
        source_cwd: flags["source-cwd"],
        branch: flags.branch,
        base: flags.base,
        path: flags.path,
        allow_dirty_source: !!flags["allow-dirty-source"],
      };
      break;
    default:
      fail("unknown command \"" + command + "\" (run with --help)");
  }

  let response;
  try {
    response = await requestOnce(endpoint, method, params, timeoutMs + 5000);
  } catch (error) {
    fail("cli_transport_error: " + error.message);
  }
  process.exit(printResponse(response, flags.pretty));
}

main();
