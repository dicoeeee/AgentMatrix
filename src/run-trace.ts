import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { AgentMatrixError } from "./errors.js";
import { AGENTMATRIX_DIR, type RunState } from "./types.js";

export const RUN_TRACE_FILE = "trace.jsonl";

export type RunTraceEventKind =
  | "run_started"
  | "run_resumed"
  | "stage_prepared"
  | "agent_invoked"
  | "command_completed"
  | "artifact_written"
  | "executor_validated"
  | "verifier_prepared"
  | "verifier_completed"
  | "stage_completed"
  | "stage_failed"
  | "run_completed"
  | "run_failed";

export interface RunTraceEvent {
  schema_version: 1;
  run_id: string;
  stage_id?: string;
  kind: RunTraceEventKind;
  status?: string;
  label: string;
  summary?: string;
  at: string;
  paths?: Record<string, string>;
}

export type RunTraceEventInput = Omit<RunTraceEvent, "schema_version" | "run_id" | "at"> & {
  at?: string;
};

const SUBMITTED_RUN_TRACE_EVENT_FIELDS = new Set([
  "schema_version",
  "run_id",
  "stage_id",
  "kind",
  "status",
  "label",
  "summary",
  "at",
  "paths"
]);

const RUN_TRACE_EVENT_KINDS = new Set<RunTraceEventKind>([
  "run_started",
  "run_resumed",
  "stage_prepared",
  "agent_invoked",
  "command_completed",
  "artifact_written",
  "executor_validated",
  "verifier_prepared",
  "verifier_completed",
  "stage_completed",
  "stage_failed",
  "run_completed",
  "run_failed"
]);

const DRIVER_PLATFORM_EVENT_KINDS = new Set<RunTraceEventKind>([
  "agent_invoked",
  "command_completed",
  "artifact_written"
]);

export async function appendRunTraceEvent(
  projectRoot: string,
  runState: RunState,
  event: RunTraceEventInput
) {
  const traceEvent: RunTraceEvent = {
    schema_version: 1,
    run_id: runState.id,
    kind: event.kind,
    label: event.label,
    at: event.at ?? new Date().toISOString(),
    ...(event.stage_id ? { stage_id: event.stage_id } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.paths ? { paths: normalizeTracePaths(event.paths) } : {})
  };

  const filePath = runTracePath(projectRoot, runState.id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(traceEvent)}\n`, "utf8");
  return traceEvent;
}

export function parseSubmittedRunTraceEvent(source: string, expectedRunId: string): RunTraceEventInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentMatrixError(`Run Trace event body is invalid JSON: ${detail}`);
  }

  if (!isJsonRecord(parsed)) {
    throw new AgentMatrixError("Run Trace event body must be a JSON object.");
  }

  for (const fieldName of Object.keys(parsed)) {
    if (!SUBMITTED_RUN_TRACE_EVENT_FIELDS.has(fieldName)) {
      throw new AgentMatrixError(`Unsupported Run Trace event field "${fieldName}".`);
    }
  }

  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw new AgentMatrixError("Run Trace event schema_version must be 1.");
  }

  if (parsed.run_id !== undefined) {
    if (typeof parsed.run_id !== "string" || parsed.run_id.trim().length === 0) {
      throw new AgentMatrixError("Run Trace event run_id must be a non-empty string.");
    }
    if (parsed.run_id !== expectedRunId) {
      throw new AgentMatrixError(`Run Trace event run_id must match positional run id "${expectedRunId}".`);
    }
  }

  if (typeof parsed.kind !== "string" || !RUN_TRACE_EVENT_KINDS.has(parsed.kind as RunTraceEventKind)) {
    throw new AgentMatrixError("Run Trace event kind is invalid.");
  }

  if (!DRIVER_PLATFORM_EVENT_KINDS.has(parsed.kind as RunTraceEventKind)) {
    throw new AgentMatrixError(
      "Driver record-event only accepts platform summary kinds: agent_invoked, command_completed, artifact_written."
    );
  }

  if (typeof parsed.label !== "string" || parsed.label.trim().length === 0) {
    throw new AgentMatrixError("Run Trace event label must be a non-empty string.");
  }

  if (!optionalString(parsed.stage_id) || parsed.stage_id === "") {
    throw new AgentMatrixError("Run Trace event stage_id must be a non-empty string when present.");
  }

  if (!optionalString(parsed.status) || parsed.status === "") {
    throw new AgentMatrixError("Run Trace event status must be a non-empty string when present.");
  }

  if (!optionalString(parsed.summary) || parsed.summary === "") {
    throw new AgentMatrixError("Run Trace event summary must be a non-empty string when present.");
  }

  if (!optionalString(parsed.at) || parsed.at === "") {
    throw new AgentMatrixError("Run Trace event at must be a non-empty string when present.");
  }

  if (!optionalStringMap(parsed.paths)) {
    throw new AgentMatrixError("Run Trace event paths must be an object with string values when present.");
  }

  return {
    kind: parsed.kind as RunTraceEventKind,
    label: parsed.label,
    ...(parsed.stage_id ? { stage_id: parsed.stage_id } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.summary ? { summary: parsed.summary } : {}),
    ...(parsed.at ? { at: parsed.at } : {}),
    ...(parsed.paths ? { paths: parsed.paths as Record<string, string> } : {})
  };
}

export async function readRunTrace(projectRoot: string, runId: string): Promise<RunTraceEvent[]> {
  const filePath = runTracePath(projectRoot, runId);
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  return source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => parseRunTraceEvent(line, filePath, index + 1));
}

export function runTracePath(projectRoot: string, runId: string) {
  return path.join(projectRoot, AGENTMATRIX_DIR, "runs", runId, RUN_TRACE_FILE);
}

function parseRunTraceEvent(line: string, filePath: string, lineNumber: number): RunTraceEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentMatrixError(`Run Trace ${filePath}:${lineNumber} is invalid JSON: ${detail}`);
  }

  if (!isRunTraceEvent(parsed)) {
    throw new AgentMatrixError(`Run Trace ${filePath}:${lineNumber} does not match schema version 1.`);
  }

  return parsed;
}

function isRunTraceEvent(value: unknown): value is RunTraceEvent {
  if (!isJsonRecord(value)) {
    return false;
  }

  return (
    value.schema_version === 1 &&
    typeof value.run_id === "string" &&
    typeof value.kind === "string" &&
    RUN_TRACE_EVENT_KINDS.has(value.kind as RunTraceEventKind) &&
    typeof value.label === "string" &&
    typeof value.at === "string" &&
    optionalString(value.stage_id) &&
    optionalString(value.status) &&
    optionalString(value.summary) &&
    optionalStringMap(value.paths)
  );
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function optionalStringMap(value: unknown) {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function normalizeTracePaths(paths: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(paths)
      .filter((entry): entry is [string, string] => entry[1].trim().length > 0)
      .map(([name, value]) => [name, normalizeTracePath(value)])
  );
}

function normalizeTracePath(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
