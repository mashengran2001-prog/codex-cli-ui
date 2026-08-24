//! Runtime control server for codex-cli-ui.
//! Ported from nebula_app/src/runtime_api (server.rs, command.rs, orchestrate.rs)
//! with the same request shape, validation rules, step contracts and workflow
//! receipts. The transport is JSON-line over TCP with a per-install token.

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { WorktreeError, WorktreeTransaction } from "./git-worktree";
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
  pid?: number;
  ai_source?: string;
  ai_session_id?: string;
  ai_state?: RuntimeWaitState;
  state_change_seq?: number;
}

export type RuntimeWaitState = "idle" | "running" | "waiting_input" | "attention" | "finished" | "failed" | "settled";

export interface RuntimeProcessSnapshot {
  pid: number;
  parent_pid?: number;
  executable: string;
  display_name: string;
  depth: number;
  agent_kind?: string;
}

export interface RuntimePaneProcesses {
  window_id: number;
  pane_id: string;
  root_pid: number;
  processes: RuntimeProcessSnapshot[];
}

export interface RuntimeLifecycleEvent {
  sequence: number;
  window_id: number;
  pane_id: string;
  event: "created" | "attached" | "detached" | "exited" | "closed";
  exit_code?: number;
  timestamp: number;
}

export interface PaneWaitResult {
  ok: boolean;
  pane?: PaneSnapshot;
  error?: string;
  observed_state?: string;
  observed_seq?: number;
}

export interface RuntimeControlCallbacks {
  windowId(): number;
  createTab(params: { cwd?: string; title?: string; shellId?: string; profileId?: string; seedCommand?: string }): Promise<{ pane_id: string }>;
  listPanes(): PaneSnapshot[];
  focusPane(paneId: string): void;
  focusWindow?(): void;
  readPane(paneId: string, lines: number): string;
  writeInput(paneId: string, text: string, submit: boolean): boolean;
  sendKey?(paneId: string, key: string, modifiers: { shift: boolean; alt: boolean; control: boolean }, repeat: number): number | false | Promise<number | false>;
  runCommand(paneId: string, command: string, timeoutMs: number): Promise<{ ok: boolean; exitCode?: number; error?: string }>;
  requestSplit(paneId: string, direction: "columns" | "rows"): Promise<{ ok: boolean; paneId?: string; error?: string }>;
  listProcesses?(paneId: string): Promise<RuntimePaneProcesses | { error: string; code?: string }>;
  waitPane?(paneId: string, state: RuntimeWaitState, timeoutMs: number, afterSeq?: number): Promise<PaneWaitResult>;
  lifecycleEvents?(sinceSequence?: number): RuntimeLifecycleEvent[];
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

const RUNTIME_KEYS = new Set([
  "escape", "enter", "tab", "backspace", "up", "down", "left", "right", "home", "end", "insert", "delete", "page_up", "page_down",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
]);

function parseRuntimeWaitState(value: unknown, label = "state"): RuntimeWaitState {
  const state = stringValue(value, label) as RuntimeWaitState;
  if (!["idle", "running", "waiting_input", "attention", "finished", "failed", "settled"].includes(state)) {
    throw invalidParams(label + " must be one of idle, running, waiting_input, attention, finished, failed, settled");
  }
  return state;
}

function parseRuntimeKey(value: unknown): string {
  const key = stringValue(value, "key").toLowerCase();
  if (!RUNTIME_KEYS.has(key)) throw invalidParams("key is not a supported runtime control key");
  return key;
}

function parseRuntimeModifiers(value: unknown): { shift: boolean; alt: boolean; control: boolean } {
  if (value === undefined || value === null) return { shift: false, alt: false, control: false };
  const object = requireObject(value, "modifiers");
  return {
    shift: booleanValue(object.shift, "modifiers.shift", false),
    alt: booleanValue(object.alt, "modifiers.alt", false),
    control: booleanValue(object.control, "modifiers.control", false),
  };
}

function paneTaskState(pane: PaneSnapshot): RuntimeWaitState {
  if (pane.status === "exited") return pane.exit_code != null && pane.exit_code !== 0 ? "failed" : "finished";
  if (pane.ai_state) return pane.ai_state;
  if (pane.activity === "running") return "running";
  if (pane.activity === "attention") return "waiting_input";
  return "idle";
}

interface ManagedAgent {
  agent_id: string;
  generation: number;
  name: string;
  kind: string;
  window_id: number;
  pane_id: string;
  session_id?: string;
  created_at: number;
  worktree?: unknown;
}

const managedAgents = new Map<string, ManagedAgent>();
let agentGeneration = 0;
let runtimeRevision = 0;
let runtimeSnapshotFingerprint: string | undefined;

function agentIdFor(name: string, paneId: string): string {
  return `agent-${name}-${paneId.slice(0, 8)}`;
}

function resolveManagedAgent(selector: string, generation: number | undefined, callbacks: RuntimeControlCallbacks): { agent: ManagedAgent; pane: PaneSnapshot } {
  const normalized = selector.trim();
  const agent = managedAgents.get(normalized) ?? [...managedAgents.values()].find((candidate) => candidate.agent_id === normalized || candidate.name === normalized);
  if (!agent) throw new ApiErrorImpl("agent_not_found", `agent "${selector}" was not found`);
  if (generation !== undefined && generation !== agent.generation) {
    throw new ApiErrorImpl("agent_generation_mismatch", `agent "${selector}" generation ${generation} is not active`, { agent_id: agent.agent_id, generation: agent.generation });
  }
  const pane = callbacks.listPanes().find((candidate) => candidate.pane_id === agent.pane_id);
  if (!pane) throw new ApiErrorImpl("agent_closed", `agent "${agent.name}" pane is no longer available`, { agent_id: agent.agent_id, generation: agent.generation });
  return { agent, pane };
}

function agentView(agent: ManagedAgent, pane: PaneSnapshot): Record<string, unknown> {
  const state = paneTaskState(pane);
  return {
    agent_id: agent.agent_id,
    generation: agent.generation,
    name: agent.name,
    kind: agent.kind,
    window_id: agent.window_id,
    pane_id: agent.pane_id,
    session_id: agent.session_id ?? pane.ai_session_id,
    active: pane.status === "running",
    observed: true,
    state,
    state_source: pane.ai_source ? "hook" : "process",
    hook_seen: Boolean(pane.ai_source),
    ...(agent.worktree === undefined ? {} : { worktree: agent.worktree }),
    ...(pane.status === "exited" ? { closed_reason: pane.exit_code == null ? "exited" : `exit_code:${pane.exit_code}` } : {}),
  };
}

function listAgentViews(callbacks: RuntimeControlCallbacks, windowId?: number): Record<string, unknown>[] {
  const panes = callbacks.listPanes();
  const views: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const agent of managedAgents.values()) {
    const pane = panes.find((candidate) => candidate.pane_id === agent.pane_id);
    if (!pane || (windowId !== undefined && pane.window_id !== windowId)) continue;
    views.push(agentView(agent, pane));
    seen.add(agent.pane_id);
  }
  for (const pane of panes) {
    if (seen.has(pane.pane_id) || !pane.ai_source || (windowId !== undefined && pane.window_id !== windowId)) continue;
    const fallback: ManagedAgent = {
      agent_id: `pane-agent-${pane.pane_id.slice(0, 8)}`,
      generation: 1,
      name: pane.title,
      kind: pane.ai_source,
      window_id: pane.window_id,
      pane_id: pane.pane_id,
      session_id: pane.ai_session_id,
      created_at: Date.now(),
    };
    views.push(agentView(fallback, pane));
  }
  return views;
}

// Canonical snapshot publishing, ported from Nebula RuntimeHub::publish.
// The revision advances only when the projected semantic state changes;
// repeated snapshots of unchanged state keep the previous revision and do
// not flood subscribers with identical snapshots.
function canonicalSnapshot(callbacks: RuntimeControlCallbacks): { window_id: number; revision: number; panes: PaneSnapshot[]; pane_count: number; pane_lifecycles: RuntimeLifecycleEvent[] } {
  const panes = callbacks.listPanes();
  const pane_lifecycles = callbacks.lifecycleEvents?.(0) ?? [];
  const fingerprint = JSON.stringify({
    panes: panes.map((pane) => [
      pane.pane_id, pane.window_id, pane.title, pane.cwd, pane.shell, pane.kind,
      pane.activity, pane.status, pane.exit_code ?? null,
      pane.ai_source ?? null, pane.ai_session_id ?? null, pane.ai_state ?? null, pane.state_change_seq ?? null,
    ]),
    pane_lifecycles: pane_lifecycles.map((event) => [event.sequence, event.window_id, event.pane_id, event.event, event.exit_code ?? null]),
  });
  if (fingerprint !== runtimeSnapshotFingerprint) {
    runtimeRevision += 1;
    runtimeSnapshotFingerprint = fingerprint;
  }
  return { window_id: callbacks.windowId(), revision: runtimeRevision, panes, pane_count: panes.length, pane_lifecycles };
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
        throw new ApiErrorImpl("command_failed", result.error || "command exited with code " + (result.exitCode ?? "unknown"), { exit_code: result.exitCode });
      }
      return { window_id: callbacks.windowId(), pane_id };
    }
    case "agent_launch": {
      const { pane_id } = resolveTarget(step.id, step.target!, actions);
      const verified = verifiedAgentLaunch(step.kind ?? "", step.resume_session_id);
      const ok = callbacks.writeInput(pane_id, verified.command, true);
      if (!ok) throw new ApiErrorImpl("pane_unavailable", "pane " + pane_id + " is not running or not attached");
      const existing = [...managedAgents.values()].find((candidate) => candidate.name === step.name);
      if (existing) throw new ApiErrorImpl("agent_name_in_use", "agent name " + step.name + " is already active");
      const agent: ManagedAgent = {
        agent_id: agentIdFor(step.name ?? verified.kind, pane_id),
        generation: ++agentGeneration,
        name: step.name ?? verified.kind,
        kind: verified.kind,
        window_id: callbacks.windowId(),
        pane_id,
        session_id: verified.sessionId,
        created_at: Date.now(),
      };
      managedAgents.set(agent.name, agent);
      if (step.initial_prompt) setTimeout(() => { callbacks.writeInput(pane_id, step.initial_prompt ?? "", true); }, 500).unref?.();
      const pane = callbacks.listPanes().find((candidate) => candidate.pane_id === pane_id);
      return { window_id: callbacks.windowId(), pane_id, agent_id: agent.agent_id, generation: agent.generation, name: agent.name, kind: agent.kind, ...(pane ? { agent: agentView(agent, pane) } : {}) };
    }    default:
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


// ---- named agent kinds (ported from nebula_app/src/ai_agents.rs) ----
// Only clients with a verified start/resume spelling are accepted; unknown
// spellings are rejected instead of guessed from their detection slug.
const AGENT_ALIASES: Record<string, string> = {
  claude: "claude", "claude-code": "claude",
  codex: "codex", "codex-cli": "codex",
  gemini: "gemini", "gemini-cli": "gemini",
  opencode: "opencode", "open-code": "opencode",
  amp: "amp", "amp-local": "amp",
  cursor: "cursor", "cursor-agent": "cursor",
  copilot: "copilot", "github-copilot": "copilot", ghcs: "copilot",
  grok: "grok", "grok-cli": "grok", "grok-build": "grok",
  pi: "pi",
  omp: "omp", "oh-my-pi": "omp",
};

const AGENT_RESUME_COMMANDS: Record<string, (sessionId: string) => string> = {
  claude: (id) => "claude --resume " + id,
  codex: (id) => "codex resume " + id,
  gemini: (id) => "gemini --resume " + id,
  opencode: (id) => "opencode --session " + id,
  amp: (id) => "amp threads continue " + id,
  cursor: (id) => "cursor-agent --resume " + id,
  copilot: (id) => "copilot --resume " + id,
  grok: (id) => "grok --resume " + id,
  pi: (id) => "pi --session " + id,
  omp: (id) => "omp --resume " + id,
};

const AGENT_START_COMMANDS: Record<string, string> = { claude: "claude", codex: "codex" };

function parseAgentKind(raw: string): string | null {
  let value = raw.trim().replace(/^["']+|["']+$/g, "").split(/[\\/]/).pop() ?? raw;
  value = value.toLowerCase();
  for (const suffix of [".exe", ".cmd", ".bat", ".ps1", ".com", ".js"]) {
    if (value.endsWith(suffix)) { value = value.slice(0, -suffix.length); break; }
  }
  return AGENT_ALIASES[value] ?? null;
}

function validSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && /^[A-Za-z0-9._-]+$/.test(id);
}

function validateAgentName(name: string): void {
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes < 1 || bytes > 64) {
    throw new ApiErrorImpl("invalid_params", "agent name must contain between 1 and 64 bytes");
  }
  if (name.trim() !== name || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ApiErrorImpl("invalid_params", "agent name must not have surrounding whitespace or control characters");
  }
}

function verifiedAgentLaunch(kindRaw: string, resumeSessionId?: string): { kind: string; sessionId?: string; command: string } {
  const kind = parseAgentKind(kindRaw);
  if (!kind) throw new ApiErrorImpl("invalid_params", "unknown agent kind \"" + kindRaw + "\"");
  if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
    if (!validSessionId(resumeSessionId)) {
      throw new ApiErrorImpl("invalid_params", "resume_session_id must be 1-64 characters of [A-Za-z0-9._-]");
    }
    const command = AGENT_RESUME_COMMANDS[kind]?.(resumeSessionId);
    if (!command) throw new ApiErrorImpl("agent_resume_unsupported", "the agent kind or session id does not have a verified resume command");
    return { kind, sessionId: resumeSessionId, command };
  }
  const command = AGENT_START_COMMANDS[kind];
  if (!command) throw new ApiErrorImpl("agent_launch_unsupported", "cold start is not verified for agent kind \"" + kind + "\"");
  return { kind, command };
}

async function dispatch(request: ApiRequest, callbacks: RuntimeControlCallbacks): Promise<ApiResponse> {
  try {
    const params = request.params === undefined ? {} : parseParams(request.params);
    switch (request.method) {
      case "runtime.describe":
        return responseFor(request, true, {
          runtime: "codex-cli-ui",
          version: 1,
          protocol_version: 1,
          capabilities: [
            "runtime.describe", "runtime.snapshot", "runtime.orchestrate", "tab.new", "window.create", "window.focus",
            "pane.focus", "pane.read", "pane.prompt", "pane.run", "pane.split", "pane.procs", "pane.send_key", "pane.wait",
            "events.pane_lifecycle", "events.subscribe", "agents.list", "agent.get", "agent.start", "agent.prompt", "agent.read", "agent.wait", "agent.fork",
          ],
          features: [
            "agent.fork.transactional_worktree", "agent.worktree.provenance", "agent.wait.identity", "pane.wait.after_seq",
            "pane.wait.lifecycle", "events.pane_lifecycle", "runtime.orchestrate.agent_ready", "pane.procs.process_tree", "pane.send_key.control_keys",
          ],
          wait_states: ["idle", "running", "waiting_input", "attention", "finished", "failed", "settled"],
        });
      case "runtime.snapshot":
        return responseFor(request, true, canonicalSnapshot(callbacks));
      case "window.create":
        throw new ApiErrorImpl("runtime_unavailable", "the runtime currently owns one workspace window; window.create is unavailable");
      case "window.focus":
        callbacks.focusWindow?.();
        return responseFor(request, true, { window_id: callbacks.windowId() });
      case "events.pane_lifecycle": {
        const since = optionalNumber(params.since_seq, "since_seq", 0, Number.MAX_SAFE_INTEGER);
        return responseFor(request, true, { events: callbacks.lifecycleEvents?.(since) ?? [] });
      }
      case "events.subscribe": {
        const sinceSeq = optionalNumber(params.since_seq, "since_seq", 0, Number.MAX_SAFE_INTEGER);
        const sinceRevision = optionalNumber(params.since_revision, "since_revision", 0, Number.MAX_SAFE_INTEGER);
        const timeoutMs = validateTimeout(params.timeout_ms ?? 30_000, "timeout_ms");
        const deadline = Date.now() + timeoutMs;
        const baselineRevision = sinceRevision ?? 0;
        let snapshot = canonicalSnapshot(callbacks);
        let events = callbacks.lifecycleEvents?.(sinceSeq) ?? [];
        while (events.length === 0 && snapshot.revision <= baselineRevision && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          snapshot = canonicalSnapshot(callbacks);
          events = callbacks.lifecycleEvents?.(sinceSeq) ?? [];
        }
        return responseFor(request, true, { revision: snapshot.revision, events, next_seq: events.at(-1)?.sequence ?? sinceSeq ?? 0, timed_out: events.length === 0 && snapshot.revision <= baselineRevision });
      }
      case "agents.list": {
        const windowId = optionalNumber(params.window_id, "window_id", 1, 0xffffffff);
        const snapshot = canonicalSnapshot(callbacks);
        return responseFor(request, true, { revision: snapshot.revision, agents: listAgentViews(callbacks, windowId) });
      }
      case "agent.get": {
        const selector = stringValue(params.agent, "agent");
        const generation = optionalNumber(params.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
        const resolved = resolveManagedAgent(selector, generation, callbacks);
        return responseFor(request, true, { agent: agentView(resolved.agent, resolved.pane), pane: resolved.pane });
      }
      case "agent.start": {
        const name = stringValue(params.name, "name");
        validateAgentName(name);
        if ([...managedAgents.values()].some((candidate) => candidate.name === name && callbacks.listPanes().some((pane) => pane.pane_id === candidate.pane_id && pane.status === "running"))) {
          throw new ApiErrorImpl("agent_name_in_use", `agent name "${name}" is already active`);
        }
        const verified = verifiedAgentLaunch(stringValue(params.kind, "kind"), optionalString(params.resume_session_id, "resume_session_id"));
        const paneId = optionalString(params.pane_id, "pane_id");
        const cwd = optionalString(params.cwd, "cwd");
        if (paneId && cwd) throw invalidParams("agent.start cannot combine pane_id with cwd; an existing pane keeps its shell cwd");
        let createdPaneId = paneId;
        if (paneId) {
          const pane = callbacks.listPanes().find((candidate) => candidate.pane_id === paneId);
          if (!pane) throw new ApiErrorImpl("pane_not_found", `pane "${paneId}" was not found`);
          if (!callbacks.writeInput(paneId, verified.command, true)) throw new ApiErrorImpl("pane_unavailable", `pane "${paneId}" is not running`);
        } else {
          createdPaneId = (await callbacks.createTab({ cwd, title: name, seedCommand: verified.command })).pane_id;
        }
        const agent: ManagedAgent = {
          agent_id: agentIdFor(name, createdPaneId!),
          generation: ++agentGeneration,
          name,
          kind: verified.kind,
          window_id: callbacks.windowId(),
          pane_id: createdPaneId!,
          session_id: verified.sessionId,
          created_at: Date.now(),
        };
        managedAgents.set(agent.name, agent);
        const pane = callbacks.listPanes().find((candidate) => candidate.pane_id === agent.pane_id);
        return responseFor(request, true, { window_id: callbacks.windowId(), pane_id: agent.pane_id, agent: pane ? agentView(agent, pane) : { ...agent } });
      }
      case "agent.prompt": {
        const selector = stringValue(params.agent, "agent");
        const generation = optionalNumber(params.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
        const text = stringValue(params.text, "text");
        validatePrompt(text);
        const submit = booleanValue(params.submit, "submit", true);
        const resolved = resolveManagedAgent(selector, generation, callbacks);
        if (!callbacks.writeInput(resolved.agent.pane_id, text, submit)) throw new ApiErrorImpl("pane_unavailable", `agent "${resolved.agent.name}" is not running`);
        return responseFor(request, true, { agent: agentView(resolved.agent, callbacks.listPanes().find((pane) => pane.pane_id === resolved.agent.pane_id) ?? resolved.pane), pane_id: resolved.agent.pane_id });
      }
      case "agent.read": {
        const selector = stringValue(params.agent, "agent");
        const generation = optionalNumber(params.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
        const lines = numberValue(params.lines ?? 100, "lines", 1, 2000);
        const resolved = resolveManagedAgent(selector, generation, callbacks);
        return responseFor(request, true, { agent: agentView(resolved.agent, resolved.pane), pane: resolved.pane, lines: callbacks.readPane(resolved.agent.pane_id, lines) });
      }
      case "agent.wait": {
        const selector = stringValue(params.agent, "agent");
        const generation = numberValue(params.generation ?? 1, "generation", 1, Number.MAX_SAFE_INTEGER);
        const state = parseRuntimeWaitState(params.state);
        const timeoutMs = validateTimeout(params.timeout_ms ?? 30_000, "timeout_ms");
        const afterSeq = optionalNumber(params.after_seq, "after_seq", 0, Number.MAX_SAFE_INTEGER);
        const resolved = resolveManagedAgent(selector, generation, callbacks);
        if (!callbacks.waitPane) throw new ApiErrorImpl("runtime_unavailable", "pane wait is not available");
        const result = await callbacks.waitPane(resolved.agent.pane_id, state, timeoutMs, afterSeq);
        if (!result.ok) throw new ApiErrorImpl(result.error === "timeout" ? "timeout" : "agent_closed", result.error || "agent did not reach the requested state", { observed_state: result.observed_state, observed_seq: result.observed_seq, agent_id: resolved.agent.agent_id, generation: resolved.agent.generation, after_seq: afterSeq });
        const pane = result.pane ?? callbacks.listPanes().find((candidate) => candidate.pane_id === resolved.agent.pane_id) ?? resolved.pane;
        return responseFor(request, true, { agent: agentView(resolved.agent, pane), snapshot: pane });
      }
      case "pane.procs": {
        const paneId = stringValue(params.pane_id, "pane_id");
        if (!callbacks.listProcesses) throw new ApiErrorImpl("runtime_unavailable", "process inspection is not available");
        const result = await callbacks.listProcesses(paneId);
        if ("error" in result) throw new ApiErrorImpl(result.code || "process_query_failed", result.error);
        return responseFor(request, true, result);
      }
      case "pane.send_key": {
        const paneId = stringValue(params.pane_id, "pane_id");
        const key = parseRuntimeKey(params.key);
        const modifiers = parseRuntimeModifiers(params.modifiers);
        const repeat = numberValue(params.repeat ?? 1, "repeat", 1, 64);
        if (key.length === 1 && !modifiers.control) throw invalidParams("letter keys require control=true; use pane.prompt for printable text");
        if (!callbacks.sendKey) throw new ApiErrorImpl("runtime_unavailable", "control-key injection is not available");
        const bytes = await callbacks.sendKey(paneId, key, modifiers, repeat);
        if (bytes === false) throw new ApiErrorImpl("pane_unavailable", `pane "${paneId}" is not running`);
        return responseFor(request, true, { pane_id: paneId, bytes_sent: bytes, key, repeat });
      }
      case "pane.wait": {
        const paneId = stringValue(params.pane_id, "pane_id");
        const state = parseRuntimeWaitState(params.state);
        const timeoutMs = validateTimeout(params.timeout_ms ?? 30_000, "timeout_ms");
        const afterSeq = optionalNumber(params.after_seq, "after_seq", 0, Number.MAX_SAFE_INTEGER);
        if (!callbacks.waitPane) throw new ApiErrorImpl("runtime_unavailable", "pane wait is not available");
        const result = await callbacks.waitPane(paneId, state, timeoutMs, afterSeq);
        if (!result.ok) throw new ApiErrorImpl(result.error === "timeout" ? "timeout" : "pane_closed", result.error || "pane did not reach the requested state", { observed_state: result.observed_state, observed_seq: result.observed_seq });
        return responseFor(request, true, { pane: result.pane, observed_state: result.observed_state, observed_seq: result.observed_seq });
      }      case "runtime.orchestrate": {
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
          throw new ApiErrorImpl("command_failed", result.error || "command exited with code " + (result.exitCode ?? "unknown"), { exit_code: result.exitCode });
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
      case "agent.fork": {
        const name = stringValue(params.name, "name");
        validateAgentName(name);
        if ([...managedAgents.values()].some((candidate) => candidate.name === name && callbacks.listPanes().some((pane) => pane.pane_id === candidate.pane_id && pane.status === "running"))) {
          throw new ApiErrorImpl("agent_name_in_use", `agent name "${name}" is already active`);
        }        const verified = verifiedAgentLaunch(stringValue(params.kind, "kind"), optionalString(params.resume_session_id, "resume_session_id"));
        const sourcePane = optionalString(params.source_pane, "source_pane");
        const sourceCwd = optionalString(params.source_cwd, "source_cwd");
        if (!sourcePane && !sourceCwd) throw invalidParams("source_pane or source_cwd is required");
        let cwd = sourceCwd;
        if (sourcePane) {
          const pane = callbacks.listPanes().find((candidate) => candidate.pane_id === sourcePane);
          if (!pane) throw new ApiErrorImpl("pane_not_found", "pane \"" + sourcePane + "\" was not found");
          if (pane.kind === "ssh") {
            throw new ApiErrorImpl("remote_worktree_unsupported", "agent.fork cannot create a local Git worktree from an SSH pane");
          }
          if (!pane.cwd || pane.cwd.trim().length === 0) {
            throw new ApiErrorImpl("cwd_unavailable", "the source pane has not reported a working directory");
          }
          if (!isAbsolute(pane.cwd)) {
            throw new ApiErrorImpl("cwd_unavailable", "the source pane did not report an absolute working directory", { cwd: pane.cwd });
          }
          cwd = pane.cwd;
        }
        if (!cwd) throw invalidParams("source_cwd must be an absolute path when source_pane is not used");
        const transaction = await WorktreeTransaction.prepare({
          source_cwd: cwd,
          agent_name: name,
          branch: optionalString(params.branch, "branch"),
          base: optionalString(params.base, "base"),
          path: optionalString(params.path, "path"),
          allow_dirty_source: booleanValue(params.allow_dirty_source, "allow_dirty_source", false),
        });
        try {
          const result = await callbacks.createTab({ cwd: transaction.provenance().path, title: name, seedCommand: verified.command });
          const provenance = transaction.commit();
          const agent: ManagedAgent = {
            agent_id: agentIdFor(name, result.pane_id),
            generation: ++agentGeneration,
            name,
            kind: verified.kind,
            window_id: callbacks.windowId(),
            pane_id: result.pane_id,
            session_id: verified.sessionId,
            created_at: Date.now(),
            worktree: provenance,
          };
          managedAgents.set(agent.name, agent);
          const pane = callbacks.listPanes().find((candidate) => candidate.pane_id === result.pane_id);
          return responseFor(request, true, { window_id: callbacks.windowId(), pane_id: result.pane_id, worktree: provenance, agent: pane ? agentView(agent, pane) : { ...agent } });
        } catch (error) {
          let rollback;
          try {
            await transaction.rollback();
          } catch (rollbackError) {
            rollback = rollbackError;
          }
          if (rollback) {
            (error as { details?: unknown }).details = { operation: (error as { details?: unknown }).details, rollback };
          }
          throw error;
        }
      }
      default:
        return responseFor(request, false, new ApiErrorImpl("method_not_found", "unknown runtime method \"" + request.method + "\""));
    }
  } catch (error) {
    if (error instanceof WorktreeError || error instanceof ApiErrorImpl) return responseFor(request, false, error);
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
