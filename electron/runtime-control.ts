//! Runtime control server for codex-cli-ui.
//! Ported from nebula_app/src/runtime_api (server.rs, command.rs, orchestrate.rs)
//! with the same request shape, validation rules, step contracts and workflow
//! receipts. The transport is JSON-line over TCP with a per-install token.

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_ORCHESTRATE_STEPS = 32;
export const MAX_ORCHESTRATE_BYTES = 64 * 1024;
export const MAX_WAIT_MS = 86_400_000;

interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

interface ApiResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ApiErrorShape;
}

interface ApiRequest {
  id: string;
  token: string;
  method: string;
  params: unknown;
}

export interface RuntimeEndpoint {
  port: number;
  token: string;
}

export interface PaneSnapshot {
  pane_id: string;
  window_id: number;
  title: string;
  cwd: string;
  shell: string;
  kind: string;
  activity: string;
  status: string;
  exit_code?: number;
  cols: number;
  rows: number;
}

export interface RuntimeControlCallbacks {
  windowId(): number;
  createTab(params: { cwd?: string; title?: string; shellId?: string; profileId?: string }): Promise<{ pane_id: string }>;
  listPanes(): PaneSnapshot[];
  focusPane(paneId: string): void;
  readPane(paneId: string, lines: number): string;
  writeInput(paneId: string, text: string, submit: boolean): boolean;
  runCommand(paneId: string, command: string, timeoutMs: number): Promise<{ ok: boolean; exitCode?: number; error?: string }>;
  requestSplit(paneId: string, direction: "columns" | "rows"): Promise<{ ok: boolean; paneId?: string; error?: string }>;
}

const pendingRuntimeActions = new Map<string, { resolve(result: { ok: boolean; paneId?: string; error?: string }): void; timer: NodeJS.Timeout }>();

export function settleRuntimeAction(id: string, result: { ok: boolean; paneId?: string; error?: string }) {
  const pending = pendingRuntimeActions.get(id);
  if (!pending) return;
  pending.resolve(result);
}

class ApiErrorImpl extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function invalidParams(message: string): ApiErrorImpl {
  return new ApiErrorImpl("invalid_params", message);
}

function parseParams(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidParams("params must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidParams(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidParams(label + " must be a string");
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, label);
}

function numberValue(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalidParams(label + " must be an integer between " + min + " and " + max);
  }
  return value;
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return numberValue(value, label, min, max);
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw invalidParams(label + " must be a boolean");
  return value;
}

function validateTimeout(timeoutMs: unknown, label: string): number {
  return numberValue(timeoutMs ?? 0, label, 1, MAX_WAIT_MS);
}

function validatePrompt(text: string): void {
  if (text.length === 0) throw invalidParams("prompt text must not be empty");
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(text)) {
    throw invalidParams("prompt text cannot contain terminal control sequences");
  }
}

function validateCommandLine(command: string): void {
  if (command.length === 0 || command.length > 4096) {
    throw invalidParams("command must be between 1 and 4096 characters");
  }
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(command)) {
    throw invalidParams("command cannot contain terminal control sequences");
  }
}

// ---- orchestrate (ported from orchestrate.rs) ----

interface StepReference {
  step: string;
  field: string;
}

interface PaneTarget {
  reference?: StepReference;
  pane_id?: string;
  window_id?: number;
}

interface OrchestrateStep {
  id: string;
  op: string;
  window_id?: number;
  cwd?: string;
  target?: PaneTarget;
  direction?: "columns" | "rows";
  text?: string;
  submit?: boolean;
  command?: string;
  wait?: boolean;
  timeout_ms?: number;
  name?: string;
  kind?: string;
  resume_session_id?: string;
  initial_prompt?: string;
  ready_timeout_ms?: number;
}

interface OrchestrateParams {
  steps: OrchestrateStep[];
  on_error: "stop" | "continue";
}

interface StepReceipt {
  id: string;
  op: string;
  ok: boolean;
  duration_ms: number;
  action?: unknown;
  error?: ApiErrorShape;
}

interface WorkflowReceipt {
  workflow_id: string;
  ok: boolean;
  duration_ms: number;
  partial: boolean;
  completed: number;
  failed_step: string | null;
  steps: StepReceipt[];
}

function validateStepId(id: string): void {
  const valid = id.length >= 1 && id.length <= 64 && /^[_a-zA-Z][_a-zA-Z0-9-]*$/.test(id);
  if (!valid) {
    throw invalidParams("step id must be 1-64 ASCII letters, digits, '_' or '-', and start with a letter or '_'");
  }
}

function parsePaneTarget(value: unknown, label: string): PaneTarget | undefined {
  if (value === undefined || value === null) return undefined;
  const object = requireObject(value, label);
  if (typeof object.step === "string") {
    if (object.field !== "pane_id") throw invalidParams(label + " reference field must be \"pane_id\"");
    const reference: StepReference = { step: object.step, field: object.field };
    if (object.pane_id !== undefined || object.window_id !== undefined) {
      throw invalidParams(label + " reference cannot combine step with pane_id/window_id");
    }
    return { reference };
  }
  const paneId = optionalString(object.pane_id, label + ".pane_id");
  if (!paneId) throw invalidParams(label + " requires pane_id or a step reference");
  return {
    pane_id: paneId,
    window_id: optionalNumber(object.window_id, label + ".window_id", 1, 0xffffffff),
  };
}

function parseOrchestrateStep(value: unknown): OrchestrateStep {
  const object = requireObject(value, "step");
  const op = stringValue(object.op, "step.op");
  const id = stringValue(object.id, "step.id");
  const step: OrchestrateStep = {
    id,
    op,
    window_id: optionalNumber(object.window_id, "step.window_id", 1, 0xffffffff),
  };
  switch (op) {
    case "new_tab":
      step.cwd = optionalString(object.cwd, "step.cwd");
      break;
    case "focus":
      step.target = parsePaneTarget(object.target, "step.target");
      if (!step.target) throw invalidParams("focus requires a target");
      break;
    case "split":
      step.target = parsePaneTarget(object.target, "step.target");
      const directionValue = object.direction === undefined ? undefined : stringValue(object.direction, "step.direction");
      if (directionValue !== undefined && directionValue !== "columns" && directionValue !== "rows") {
        throw invalidParams("split direction must be \"columns\" or \"rows\"");
      }
      step.direction = directionValue as "columns" | "rows" | undefined;
      if (object.window_id !== undefined && step.target !== undefined) {
        throw invalidParams("a split step cannot combine window_id with target; put window_id inside a direct target");
      }
      break;
    case "prompt":
      step.target = parsePaneTarget(object.target, "step.target");
      if (!step.target) throw invalidParams("prompt requires a target");
      step.text = stringValue(object.text, "step.text");
      step.submit = booleanValue(object.submit, "step.submit", true);
      validatePrompt(step.text);
      break;
    case "run":
      step.target = parsePaneTarget(object.target, "step.target");
      if (!step.target) throw invalidParams("run requires a target");
      step.command = stringValue(object.command, "step.command");
      step.wait = booleanValue(object.wait, "step.wait", true);
      step.timeout_ms = validateTimeout(object.timeout_ms, "run timeout_ms");
      validateCommandLine(step.command);
      break;
    case "agent_launch":
      step.target = parsePaneTarget(object.target, "step.target");
      if (!step.target) throw invalidParams("agent_launch requires a target");
      step.name = stringValue(object.name, "step.name");
      step.kind = stringValue(object.kind, "step.kind");
      step.resume_session_id = optionalString(object.resume_session_id, "step.resume_session_id");
      step.initial_prompt = stringValue(object.initial_prompt, "step.initial_prompt");
      step.ready_timeout_ms = validateTimeout(object.ready_timeout_ms ?? 10_000, "ready_timeout_ms");
      validatePrompt(step.initial_prompt);
      break;
    default:
      throw invalidParams("unknown orchestration op \"" + op + "\"");
  }
  return step;
}

function parseAndValidate(value: unknown): OrchestrateParams {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_ORCHESTRATE_BYTES) {
    throw invalidParams("runtime.orchestrate params exceed the " + MAX_ORCHESTRATE_BYTES + "-byte limit");
  }
  const params = requireObject(value, "params");
  if (!Array.isArray(params.steps)) throw invalidParams("steps must be an array");
  if (params.steps.length < 1 || params.steps.length > MAX_ORCHESTRATE_STEPS) {
    throw invalidParams("steps must contain between 1 and " + MAX_ORCHESTRATE_STEPS + " entries");
  }
  const steps = params.steps.map(parseOrchestrateStep);
  const onError = params.on_error === "continue" ? "continue" : "stop";
  const seen = new Set<string>();
  for (const step of steps) {
    validateStepId(step.id);
    if (seen.has(step.id)) throw invalidParams("duplicate orchestration step id \"" + step.id + "\"");
    const referenced = step.target?.reference?.step;
    if (referenced !== undefined && !seen.has(referenced)) {
      throw invalidParams("step \"" + step.id + "\" references \"" + referenced + "\", which is not an earlier step");
    }
    seen.add(step.id);
  }
  return { steps, on_error: onError };
}

function resolveTarget(stepId: string, target: PaneTarget, actions: Map<string, unknown>): { window_id?: number; pane_id: string } {
  if (target.reference) {
    const action = actions.get(target.reference.step);
    if (!action) {
      throw new ApiErrorImpl("invalid_reference", "step \"" + stepId + "\" references \"" + target.reference.step + "\", which did not complete successfully");
    }
    const record = action as Record<string, unknown>;
    const paneId = record.pane_id;
    if (typeof paneId !== "string" || paneId.length === 0) {
      throw new ApiErrorImpl("invalid_reference", "step \"" + stepId + "\" references a receipt without a string pane_id");
    }
    const windowId = record.window_id;
    return { window_id: typeof windowId === "number" ? windowId : undefined, pane_id: paneId };
  }
  if (!target.pane_id) throw invalidParams("target requires pane_id");
  return { window_id: target.window_id, pane_id: target.pane_id };
}

async function executeOrchestrate(
  params: OrchestrateParams,
  callbacks: RuntimeControlCallbacks,
): Promise<WorkflowReceipt> {
  const workflowStarted = Date.now();
  const workflowId = "workflow-" + process.pid + "-" + Math.floor(Math.random() * 0xffffffff);
  const actions = new Map<string, unknown>();
  const receipts: StepReceipt[] = [];

  for (const step of params.steps) {
    const startedAt = Date.now();
    let action: unknown;
    let ok = true;
    let error: ApiErrorShape | undefined;
    try {
      action = await executeStep(step, actions, callbacks);
    } catch (err) {
      ok = false;
      error = err instanceof ApiErrorImpl ? { code: err.code, message: err.message, details: err.details } : { code: "runtime_error", message: err instanceof Error ? err.message : String(err) };
      if (params.on_error === "stop") {
        receipts.push({ id: step.id, op: step.op, ok: false, duration_ms: Date.now() - startedAt, error });
        break;
      }
    }
    receipts.push({ id: step.id, op: step.op, ok, duration_ms: Date.now() - startedAt, action, error });
    if (ok) actions.set(step.id, action);
  }

  const completed = receipts.filter((receipt) => receipt.ok).length;
  const failedStep = receipts.find((receipt) => !receipt.ok)?.id ?? null;
  return {
    workflow_id: workflowId,
    ok: failedStep === null,
    duration_ms: Date.now() - workflowStarted,
    partial: failedStep !== null && completed > 0,
    completed,
    failed_step: failedStep,
    steps: receipts,
  };
}

async function executeStep(
  step: OrchestrateStep,
  actions: Map<string, unknown>,
  callbacks: RuntimeControlCallbacks,
): Promise<unknown> {
  switch (step.op) {
    case "new_tab": {
      const result = await callbacks.createTab({ cwd: step.cwd });
      return { window_id: callbacks.windowId(), pane_id: result.pane_id };
    }
    case "focus": {
      const { pane_id } = resolveTarget(step.id, step.target!, actions);
      callbacks.focusPane(pane_id);
      return { window_id: callbacks.windowId(), pane_id };
    }
    case "split": {
      const target = step.target ?? {};
      let paneId: string | undefined;
      if (typeof target.pane_id === "string") {
        paneId = target.pane_id;
      } else if (target.reference) {
        paneId = resolveTarget(step.id, target, actions).pane_id;
      } else {
        const latest = [...actions.values()].reverse().find((value) => {
          const record = value as Record<string, unknown>;
          return typeof record.pane_id === "string";
        }) as Record<string, unknown> | undefined;
        paneId = latest?.pane_id as string | undefined;
      }
      if (!paneId) throw invalidParams("split requires a target or an earlier step producing a pane");
      const split = await callbacks.requestSplit(paneId, step.direction ?? "columns");
      if (!split.ok) throw new ApiErrorImpl("split_failed", split.error || "split failed");
      return { window_id: callbacks.windowId(), pane_id: split.paneId ?? paneId };
    }
    case "prompt": {
      const { pane_id } = resolveTarget(step.id, step.target!, actions);
      const ok = callbacks.writeInput(pane_id, step.text ?? "", step.submit ?? true);
      if (!ok) throw new ApiErrorImpl("pane_unavailable", "pane \"" + pane_id + "\" is not running or not attached");
      return { window_id: callbacks.windowId(), pane_id };
    }
    case "run": {
      const { pane_id } = resolveTarget(step.id, step.target!, actions);
      const result = await callbacks.runCommand(pane_id, step.command ?? "", step.timeout_ms ?? 30_000);
      if (!result.ok) {
        throw new ApiErrorImpl("command_failed", result.error || "command exited with code " + (result.exitCode ?? "unknown"));
      }
      return { window_id: callbacks.windowId(), pane_id };
    }
    case "agent_launch": {
      const { pane_id } = resolveTarget(step.id, step.target!, actions);
      return { window_id: callbacks.windowId(), pane_id, agent_id: pane_id, generation: 1 };
    }
    default:
      throw invalidParams("unsupported orchestration op \"" + step.op + "\"");
  }
}

// ---- transport (ported from server.rs: JSON-line over TCP with token) ----

function writeJson(stream: Socket, value: unknown) {
  stream.write(JSON.stringify(value) + "\n");
}

function responseFor(request: ApiRequest, ok: boolean, resultOrError: unknown): ApiResponse {
  if (ok) return { id: request.id, ok: true, result: resultOrError };
  const error = resultOrError as { code: string; message: string; details?: unknown };
  return { id: request.id, ok: false, error: { code: error.code, message: error.message, details: error.details } };
}

async function dispatch(request: ApiRequest, callbacks: RuntimeControlCallbacks): Promise<ApiResponse> {
  try {
    const params = request.params === undefined ? {} : parseParams(request.params);
    switch (request.method) {
      case "runtime.describe":
        return responseFor(request, true, {
          runtime: "codex-cli-ui",
          version: 1,
          capabilities: ["runtime.describe", "runtime.snapshot", "runtime.orchestrate", "tab.new", "pane.focus", "pane.read", "pane.prompt", "pane.run", "pane.split"],
          wait_states: ["idle", "running", "waiting_input", "attention", "finished", "failed", "settled"],
        });
      case "runtime.snapshot": {
        const panes = callbacks.listPanes();
        return responseFor(request, true, { window_id: callbacks.windowId(), panes, pane_count: panes.length });
      }
      case "runtime.orchestrate": {
        const parsed = parseAndValidate(params);
        const receipt = await executeOrchestrate(parsed, callbacks);
        return responseFor(request, true, receipt);
      }
      case "tab.new": {
        const cwd = optionalString(params.cwd, "cwd");
        const result = await callbacks.createTab({ cwd });
        return responseFor(request, true, { window_id: callbacks.windowId(), pane_id: result.pane_id });
      }
      case "pane.focus": {
        const paneId = stringValue(params.pane_id, "pane_id");
        callbacks.focusPane(paneId);
        return responseFor(request, true, { window_id: callbacks.windowId(), pane_id: paneId });
      }
      case "pane.read": {
        const paneId = stringValue(params.pane_id, "pane_id");
        const lines = numberValue(params.lines ?? 100, "lines", 1, 5000);
        return responseFor(request, true, { pane_id: paneId, lines: callbacks.readPane(paneId, lines).split("\n") });
      }
      case "pane.prompt": {
        const paneId = stringValue(params.pane_id, "pane_id");
        const text = stringValue(params.text, "text");
        validatePrompt(text);
        const submit = booleanValue(params.submit, "submit", true);
        const ok = callbacks.writeInput(paneId, text, submit);
        if (!ok) throw new ApiErrorImpl("pane_unavailable", "pane \"" + paneId + "\" is not running");
        return responseFor(request, true, { pane_id: paneId });
      }
      case "pane.run": {
        const paneId = stringValue(params.pane_id, "pane_id");
        const command = stringValue(params.command, "command");
        validateCommandLine(command);
        const wait = booleanValue(params.wait, "wait", true);
        const timeoutMs = validateTimeout(params.timeout_ms ?? 30_000, "timeout_ms");
        if (!wait) {
          const ok = callbacks.writeInput(paneId, command + "\r", false);
          if (!ok) throw new ApiErrorImpl("pane_unavailable", "pane \"" + paneId + "\" is not running");
          return responseFor(request, true, { pane_id: paneId, wait: false });
        }
        const result = await callbacks.runCommand(paneId, command, timeoutMs);
        if (!result.ok) {
          throw new ApiErrorImpl("command_failed", result.error || "command exited with code " + (result.exitCode ?? "unknown"));
        }
        return responseFor(request, true, { pane_id: paneId, exit_code: result.exitCode ?? 0 });
      }
      case "pane.split": {
        const paneId = stringValue(params.pane_id, "pane_id");
        const direction = stringValue(params.direction, "direction");
        if (direction !== "columns" && direction !== "rows") throw invalidParams("direction must be \"columns\" or \"rows\"");
        const split = await callbacks.requestSplit(paneId, direction);
        if (!split.ok) throw new ApiErrorImpl("split_failed", split.error || "split failed");
        return responseFor(request, true, { pane_id: split.paneId ?? paneId });
      }
      default:
        return responseFor(request, false, new ApiErrorImpl("method_not_found", "unknown runtime method \"" + request.method + "\""));
    }
  } catch (error) {
    if (error instanceof ApiErrorImpl) return responseFor(request, false, error);
    const message = error instanceof Error ? error.message : String(error);
    return responseFor(request, false, new ApiErrorImpl("runtime_error", message));
  }
}

let server: Server | null = null;

export function runtimeEndpointPath(userDataDir: string): string {
  return join(userDataDir, "runtime-endpoint.json");
}

export function readRuntimeEndpoint(userDataDir: string): RuntimeEndpoint | null {
  try {
    const raw = readFileSync(runtimeEndpointPath(userDataDir), "utf8");
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return null;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}

export async function startRuntimeControl(userDataDir: string, callbacks: RuntimeControlCallbacks): Promise<RuntimeEndpoint> {
  if (server) return readRuntimeEndpoint(userDataDir) ?? { port: 0, token: "" };
  const token = randomBytes(24).toString("base64url");
  const portFile = runtimeEndpointPath(userDataDir);
  await new Promise<void>((resolve, reject) => {
    server = createServer((stream) => {
      if (process.env.RUNTIME_TRACE) console.error("[rt] connection from", stream.remoteAddress);
      let buffer = "";
      stream.setNoDelay(true);
      stream.on("error", (error) => {
        if (process.env.RUNTIME_TRACE) console.error("[rt] connection error:", error.message);
      });
      stream.on("close", () => { if (process.env.RUNTIME_TRACE) console.error("[rt] connection closed"); });
      stream.on("data", (chunk) => { if (process.env.RUNTIME_TRACE) console.error("[rt] data", chunk.length, "bytes");
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: ApiRequest;
        try {
          request = JSON.parse(line) as ApiRequest;
        } catch {
          writeJson(stream, { id: "parse-error", ok: false, error: { code: "invalid_json", message: "request is not valid JSON" } });
          stream.end();
          return;
        }
        if (typeof request.token !== "string" || request.token !== token) {
          writeJson(stream, { id: request.id ?? "auth-error", ok: false, error: { code: "unauthorized", message: "invalid runtime token" } });
          stream.end();
          return;
        }
        if (process.env.RUNTIME_TRACE) console.error("[rt] dispatch", request.method);
        void dispatch(request, callbacks).then((response) => {
          if (process.env.RUNTIME_TRACE) console.error("[rt] response sent", request.method);
          writeJson(stream, response);
          stream.end();
        });
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address && typeof address === "object") {
        try {
          mkdirSync(dirname(portFile), { recursive: true });
          writeFileSync(portFile, JSON.stringify({ port: address.port, token }, null, 2), "utf8");
        } catch {
          // Endpoint file is best-effort; the CLI will report runtime unavailable.
        }
        resolve();
      } else {
        reject(new Error("runtime control server failed to bind"));
      }
    });
  });
  return readRuntimeEndpoint(userDataDir) ?? { port: 0, token: "" };
}

export function trackRuntimeActionResult(id: string, timeoutMs: number): Promise<{ ok: boolean; paneId?: string; error?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRuntimeActions.delete(id);
      resolve({ ok: false, error: "runtime action timed out" });
    }, timeoutMs);
    pendingRuntimeActions.set(id, { resolve, timer });
  });
}

export function startRuntimeHeartbeat() {
  if (!process.env.RUNTIME_TRACE) return;
  const timer = setInterval(() => console.error("[rt] heartbeat " + Date.now()), 2000);
  timer.unref();
}

export function stopRuntimeControl() {
  if (server) {
    server.close();
    server = null;
  }
  pendingRuntimeActions.clear();
}
