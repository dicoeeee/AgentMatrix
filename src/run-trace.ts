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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.schema_version === 1 &&
    typeof record.run_id === "string" &&
    typeof record.kind === "string" &&
    RUN_TRACE_EVENT_KINDS.has(record.kind as RunTraceEventKind) &&
    typeof record.label === "string" &&
    typeof record.at === "string" &&
    optionalString(record.stage_id) &&
    optionalString(record.status) &&
    optionalString(record.summary) &&
    optionalStringMap(record.paths)
  );
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
