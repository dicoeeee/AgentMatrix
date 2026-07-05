import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeProjectJson } from "./project-files.js";
import {
  parseStageReport,
  type StageReport,
  type StageReportBlocker,
  type StageReportCommand
} from "./stage-report.js";
import type { RunStageState, StageExecutionContext, StageExecutionResult, WorkflowInput } from "./types.js";

type ReviewLaneId = "correctness" | "security" | "maintainability" | "performance" | "data" | "api";
type ReviewSeverity = "critical" | "major" | "minor" | "info";

interface ReviewLane {
  id: ReviewLaneId;
  name: string;
  aliases: string[];
}

interface PriorStageReport {
  inputId: string;
  stageId: string;
  path: string;
  report: StageReport;
}

interface ReviewEvidenceLink {
  stage_id: string;
  artifact: string;
  detail?: string;
  command?: string;
}

interface ReviewFindingDraft {
  lane: ReviewLaneId;
  severity: ReviewSeverity;
  rootCause: string;
  message: string;
  sourceStage: string;
  evidence: ReviewEvidenceLink;
}

interface ReviewFinding extends Record<string, unknown> {
  id: string;
  severity: ReviewSeverity;
  root_cause: string;
  message: string;
  lanes: ReviewLaneId[];
  source_stages: string[];
  evidence: ReviewEvidenceLink[];
}

interface ReviewLaneResult {
  command: StageReportCommand;
  findings: ReviewFindingDraft[];
}

const REVIEW_PARALLEL_GROUP = "code-review-lanes-1";
const MISSING_EVIDENCE_REASON = "Required prior stage evidence is missing.";
const REVIEW_LANES: ReviewLane[] = [
  {
    id: "correctness",
    name: "Correctness",
    aliases: ["correctness", "bug", "test", "failure", "failing", "regression", "logic"]
  },
  {
    id: "security",
    name: "Security",
    aliases: ["security", "vulnerability", "vuln", "auth", "authorization", "injection", "xss", "csrf", "secret"]
  },
  {
    id: "maintainability",
    name: "Maintainability",
    aliases: ["maintainability", "maintainable", "lint", "style", "complexity", "readability", "refactor", "static"]
  },
  {
    id: "performance",
    name: "Performance",
    aliases: ["performance", "perf", "slow", "latency", "memory", "query"]
  },
  {
    id: "data",
    name: "Data",
    aliases: ["data", "database", "db", "migration", "schema", "persistence"]
  },
  {
    id: "api",
    name: "API",
    aliases: ["api", "contract", "endpoint", "interface", "public-api"]
  }
];
const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  info: 1
};
const SOURCE_STAGE_ORDER = ["static_check", "test_check", "code_review"];

export async function executeCodeReviewStage(context: StageExecutionContext): Promise<StageExecutionResult> {
  const { reports, blockers } = await readRequiredPriorReports(context);

  if (blockers.length > 0) {
    await writeBlockedReview(context, blockers);
    return {
      stageReportPath: context.stageReportPath,
      evidencePath: context.executorEvidencePath
    };
  }

  const laneResults = await Promise.all(REVIEW_LANES.map((lane) => executeReviewLane(lane, reports)));
  const findings = mergeFindings(laneResults.flatMap((result) => result.findings));
  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status: "success",
    summary: reviewSummary(findings.length),
    commands: laneResults.map((result) => result.command),
    findings,
    artifacts: [context.stageReportPath],
    skipped: [],
    changed_files: [],
    blockers: []
  };

  await writeProjectJson(context.projectRoot, context.executorEvidencePath, {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    agent_role: context.stage.agentRole,
    status: "success",
    summary: report.summary,
    inputs: reports.map((priorReport) => ({
      id: priorReport.inputId,
      stage_id: priorReport.stageId,
      artifact: priorReport.path
    })),
    lanes: REVIEW_LANES.map((lane) => lane.id),
    finding_count: findings.length
  });
  await writeProjectJson(context.projectRoot, context.stageReportPath, report);

  return {
    stageReportPath: context.stageReportPath,
    evidencePath: context.executorEvidencePath
  };
}

async function writeBlockedReview(context: StageExecutionContext, blockers: StageReportBlocker[]) {
  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status: "failed",
    summary: `Code review could not start because ${blockers.length} required input ${
      blockers.length === 1 ? "report is" : "reports are"
    } missing.`,
    commands: skippedLaneCommands(),
    findings: [],
    artifacts: [context.stageReportPath],
    skipped: [
      {
        id: "review-lanes",
        reason: MISSING_EVIDENCE_REASON
      }
    ],
    changed_files: [],
    blockers
  };

  await writeProjectJson(context.projectRoot, context.executorEvidencePath, {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    agent_role: context.stage.agentRole,
    status: "failed",
    summary: report.summary,
    blockers
  });
  await writeProjectJson(context.projectRoot, context.stageReportPath, report);
}

async function readRequiredPriorReports(context: StageExecutionContext) {
  const reports: PriorStageReport[] = [];
  const blockers: StageReportBlocker[] = [];
  const inputs = context.stage.inputs.filter((input) => input.required && input.sourceStage && input.output);

  for (const input of inputs) {
    const sourceStage = context.runState.stages.find((stage) => stage.id === input.sourceStage);
    const reportPath = sourceStage ? sourceOutputPath(context.runState.artifactPath, sourceStage, input) : undefined;

    if (!sourceStage || !reportPath) {
      blockers.push(missingInputBlocker(input, reportPath));
      continue;
    }

    try {
      const report = parseStageReport(await readFile(path.join(context.projectRoot, reportPath), "utf8"), reportPath);
      assertPriorReportMatchesRun(context, report, sourceStage, reportPath);
      reports.push({
        inputId: input.id,
        stageId: sourceStage.id,
        path: reportPath,
        report
      });
    } catch {
      blockers.push(missingInputBlocker(input, reportPath));
    }
  }

  return { reports, blockers };
}

function sourceOutputPath(artifactPath: string, sourceStage: RunStageState, input: WorkflowInput) {
  const output = sourceStage.outputs.find((candidate) => candidate.id === input.output);
  return output ? path.join(artifactPath, output.path) : undefined;
}

function assertPriorReportMatchesRun(
  context: StageExecutionContext,
  report: StageReport,
  sourceStage: RunStageState,
  reportPath: string
) {
  if (report.run_id !== context.runState.id) {
    throw new Error(`Prior stage report ${reportPath} has the wrong run_id.`);
  }

  if (report.stage_id !== sourceStage.id) {
    throw new Error(`Prior stage report ${reportPath} has the wrong stage_id.`);
  }
}

function missingInputBlocker(input: WorkflowInput, reportPath: string | undefined): StageReportBlocker {
  return {
    type: "missing_resource",
    message: `Required input "${input.id}" is missing or unreadable at ${reportPath ?? input.sourceStage ?? input.id}.`,
    ...(reportPath ? { resource: reportPath } : {})
  };
}

async function executeReviewLane(lane: ReviewLane, reports: PriorStageReport[]): Promise<ReviewLaneResult> {
  const startedAt = Date.now();
  const findings = reports.flatMap((report) => findingsForLane(lane, report));

  return {
    command: {
      name: `${lane.name} Review`,
      command: `review:${lane.id}`,
      status: "success",
      parallel_group: REVIEW_PARALLEL_GROUP,
      duration_ms: Date.now() - startedAt,
      summary: laneSummary(findings.length)
    },
    findings
  };
}

function findingsForLane(lane: ReviewLane, priorReport: PriorStageReport) {
  const findingDrafts = priorReport.report.findings
    .filter((finding) => findingMatchesLane(lane, priorReport, finding))
    .map((finding) => reviewFindingFromReportFinding(lane, priorReport, finding));
  const commandDrafts = priorReport.report.commands
    .filter((command) => command.status === "failed" || (command.exit_code !== undefined && command.exit_code !== 0))
    .filter((command) => commandMatchesLane(lane, priorReport, command))
    .map((command) => reviewFindingFromCommand(lane, priorReport, command));

  return [...findingDrafts, ...commandDrafts];
}

function findingMatchesLane(lane: ReviewLane, priorReport: PriorStageReport, finding: Record<string, unknown>) {
  const explicitLaneIds = classifyExplicitLaneIds(finding);

  if (explicitLaneIds.size > 0) {
    return explicitLaneIds.has(lane.id);
  }

  if (textMatchesLane(JSON.stringify(finding).toLowerCase(), lane)) {
    return true;
  }

  if (priorReport.stageId === "test_check") {
    return lane.id === "correctness";
  }

  if (priorReport.stageId === "static_check") {
    return lane.id === "maintainability";
  }

  return false;
}

function commandMatchesLane(lane: ReviewLane, priorReport: PriorStageReport, command: StageReportCommand) {
  const commandText = [command.name, command.command, command.summary].filter(Boolean).join(" ").toLowerCase();

  if (textMatchesLane(commandText, lane)) {
    return true;
  }

  return priorReport.stageId === "test_check" && lane.id === "correctness";
}

function reviewFindingFromReportFinding(
  lane: ReviewLane,
  priorReport: PriorStageReport,
  finding: Record<string, unknown>
): ReviewFindingDraft {
  const message = stringField(finding, ["message", "summary", "description"]) ?? "Prior evidence reported a risk.";
  const rootCause = stringField(finding, ["root_cause", "rootCause"]) ?? message;

  return {
    lane: lane.id,
    severity: normalizeSeverity(stringField(finding, ["severity"])),
    rootCause,
    message,
    sourceStage: priorReport.stageId,
    evidence: {
      stage_id: priorReport.stageId,
      artifact: priorReport.path,
      detail: stringField(finding, ["evidence", "location", "path", "file", "message", "summary"])
    }
  };
}

function reviewFindingFromCommand(
  lane: ReviewLane,
  priorReport: PriorStageReport,
  command: StageReportCommand
): ReviewFindingDraft {
  const message = command.summary ?? `${priorReport.stageId} command failed: ${command.command}.`;

  return {
    lane: lane.id,
    severity: "critical",
    rootCause: command.command,
    message,
    sourceStage: priorReport.stageId,
    evidence: {
      stage_id: priorReport.stageId,
      artifact: priorReport.path,
      command: command.command,
      detail: command.summary
    }
  };
}

function classifyExplicitLaneIds(finding: Record<string, unknown>) {
  const laneIds = new Set<ReviewLaneId>();
  const values = ["lane", "category", "risk", "source", "kind", "type"].flatMap((fieldName) =>
    stringValues(finding[fieldName])
  );

  for (const value of values) {
    for (const lane of REVIEW_LANES) {
      if (valueMatchesLane(value, lane)) {
        laneIds.add(lane.id);
      }
    }
  }

  return laneIds;
}

function valueMatchesLane(value: string, lane: ReviewLane) {
  const normalized = value.toLowerCase();
  return normalized === lane.id || lane.aliases.some((alias) => normalized.includes(alias));
}

function textMatchesLane(text: string, lane: ReviewLane) {
  return lane.aliases.some((alias) => text.includes(alias));
}

function mergeFindings(drafts: ReviewFindingDraft[]): ReviewFinding[] {
  const groups = new Map<string, ReviewFindingDraft[]>();

  for (const draft of drafts) {
    const key = normalizeRootCause(draft.rootCause);
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  }

  return [...groups.values()].map(mergeFindingGroup).sort(compareFindings);
}

function mergeFindingGroup(group: ReviewFindingDraft[]): ReviewFinding {
  const sortedBySeverity = [...group].sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]);
  const representative = sortedBySeverity[0];
  const rootCause = representative.rootCause;
  const lanes = uniqueSorted(
    group.map((draft) => draft.lane),
    (lane) => REVIEW_LANES.findIndex((candidate) => candidate.id === lane)
  );
  const sourceStages = uniqueSorted(group.map((draft) => draft.sourceStage), sourceStageIndex);
  const evidence = dedupeEvidence(group.map((draft) => draft.evidence));

  return {
    id: `review-${normalizeRootCause(rootCause)}`,
    severity: representative.severity,
    root_cause: rootCause,
    message: representative.message,
    lanes,
    source_stages: sourceStages,
    evidence
  };
}

function compareFindings(left: ReviewFinding, right: ReviewFinding) {
  const severityDelta = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  return severityDelta === 0 ? left.root_cause.localeCompare(right.root_cause) : severityDelta;
}

function dedupeEvidence(evidence: ReviewEvidenceLink[]) {
  const seen = new Set<string>();
  const result: ReviewEvidenceLink[] = [];

  for (const item of evidence) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function uniqueSorted<T extends string>(values: T[], indexForValue: (value: T) => number): T[] {
  return [...new Set(values)].sort((left, right) => indexForValue(left) - indexForValue(right));
}

function sourceStageIndex(stageId: string) {
  const index = SOURCE_STAGE_ORDER.indexOf(stageId);
  return index === -1 ? SOURCE_STAGE_ORDER.length : index;
}

function normalizeSeverity(value: string | undefined): ReviewSeverity {
  const normalized = value?.toLowerCase();

  if (normalized === "blocker" || normalized === "critical" || normalized === "high") {
    return "critical";
  }

  if (normalized === "major" || normalized === "error" || normalized === "failed" || normalized === "medium") {
    return "major";
  }

  if (normalized === "minor" || normalized === "warning" || normalized === "low") {
    return "minor";
  }

  if (normalized === "info" || normalized === "informational") {
    return "info";
  }

  return "major";
}

function stringField(record: Record<string, unknown>, fieldNames: string[]) {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(stringValues);
  }

  return [];
}

function normalizeRootCause(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown-root-cause";
}

function skippedLaneCommands(): StageReportCommand[] {
  return REVIEW_LANES.map((lane) => ({
    name: `${lane.name} Review`,
    command: `review:${lane.id}`,
    status: "skipped",
    parallel_group: REVIEW_PARALLEL_GROUP,
    reason: MISSING_EVIDENCE_REASON
  }));
}

function laneSummary(findingCount: number) {
  if (findingCount === 0) {
    return "No actionable findings.";
  }

  if (findingCount === 1) {
    return "1 actionable finding.";
  }

  return `${findingCount} actionable findings.`;
}

function reviewSummary(findingCount: number) {
  if (findingCount === 0) {
    return "Code review found no actionable findings across 6 reviewer lanes.";
  }

  return `Code review found ${findingCount} actionable findings across 6 reviewer lanes.`;
}
