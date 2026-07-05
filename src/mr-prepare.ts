import path from "node:path";

import { writeProjectJson, writeProjectText } from "./project-files.js";
import { readRequiredStageInputReports, type StageInputReport } from "./stage-input-reports.js";
import type {
  StageReport,
  StageReportBlocker,
  StageReportCommand,
  StageReportStatus
} from "./stage-report.js";
import type { StageExecutionContext, StageExecutionResult } from "./types.js";

interface MrPrepareOutputs {
  stageReportPath: string;
  titlePath: string;
  descriptionPath: string;
  artifacts: string[];
}

const NO_EXTERNAL_ACTION_NOTE = "No MR, PR, reviewer, label, push, or CI-watch action was performed.";

export async function executeMrPrepareStage(context: StageExecutionContext): Promise<StageExecutionResult> {
  const outputs = mrPrepareOutputs(context);
  const { reports, blockers } = await readRequiredStageInputReports(context);

  if (blockers.length > 0) {
    await writeBlockedPreparation(context, outputs, blockers);
    return {
      stageReportPath: context.stageReportPath,
      evidencePath: context.executorEvidencePath
    };
  }

  const findings = collectFindings(reports);
  const title = `${titleFromReports(reports)}\n`;
  const description = descriptionFromReports(reports);
  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status: "success",
    summary: `Generated MR title and description from ${reports.length} prior stage reports.`,
    commands: [],
    findings,
    artifacts: outputs.artifacts,
    skipped: [],
    changed_files: [],
    blockers: []
  };

  await writeProjectText(context.projectRoot, outputs.titlePath, title);
  await writeProjectText(context.projectRoot, outputs.descriptionPath, description);
  await writeExecutorEvidence(context, "success", report.summary, outputs, reports);
  await writeProjectJson(context.projectRoot, outputs.stageReportPath, report);

  return {
    stageReportPath: context.stageReportPath,
    evidencePath: context.executorEvidencePath
  };
}

async function writeBlockedPreparation(
  context: StageExecutionContext,
  outputs: MrPrepareOutputs,
  blockers: StageReportBlocker[]
) {
  const title = "MR preparation blocked\n";
  const description = blockedDescription(blockers);
  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status: "failed",
    summary: `MR preparation could not start because ${blockers.length} required input ${
      blockers.length === 1 ? "report is" : "reports are"
    } missing.`,
    commands: [],
    findings: [],
    artifacts: outputs.artifacts,
    skipped: [
      {
        id: "mr-prepare",
        reason: "Required prior stage evidence is missing."
      }
    ],
    changed_files: [],
    blockers
  };

  await writeProjectText(context.projectRoot, outputs.titlePath, title);
  await writeProjectText(context.projectRoot, outputs.descriptionPath, description);
  await writeExecutorEvidence(context, "failed", report.summary, outputs, [], blockers);
  await writeProjectJson(context.projectRoot, outputs.stageReportPath, report);
}

async function writeExecutorEvidence(
  context: StageExecutionContext,
  status: StageReportStatus,
  summary: string,
  outputs: MrPrepareOutputs,
  reports: StageInputReport[],
  blockers: StageReportBlocker[] = []
) {
  await writeProjectJson(context.projectRoot, context.executorEvidencePath, {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    agent_role: context.stage.agentRole,
    status,
    summary,
    inputs: reports.map((report) => ({
      id: report.inputId,
      stage_id: report.stageId,
      artifact: report.path
    })),
    outputs: [
      { id: "stage_report", path: outputs.stageReportPath },
      { id: "mr_title", path: outputs.titlePath },
      { id: "mr_description", path: outputs.descriptionPath }
    ],
    external_actions: [],
    blockers
  });
}

function mrPrepareOutputs(context: StageExecutionContext): MrPrepareOutputs {
  const stageReportPath = context.stageReportPath;
  const titlePath = outputPath(context, "mr_title");
  const descriptionPath = outputPath(context, "mr_description");

  return {
    stageReportPath,
    titlePath,
    descriptionPath,
    artifacts: [stageReportPath, titlePath, descriptionPath]
  };
}

function outputPath(context: StageExecutionContext, outputId: string) {
  const output = context.stage.outputs.find((candidate) => candidate.id === outputId);

  if (!output) {
    throw new Error(`Stage "${context.stage.id}" does not declare output "${outputId}".`);
  }

  return path.join(context.runState.artifactPath, output.path);
}

function titleFromReports(reports: StageInputReport[]) {
  if (reports.some(reportNeedsAttention)) {
    return "MR: validation needs attention";
  }

  return "MR: validation passed";
}

function reportNeedsAttention(priorReport: StageInputReport) {
  const report = priorReport.report;
  return (
    report.status !== "success" ||
    report.findings.length > 0 ||
    (report.blockers?.length ?? 0) > 0 ||
    report.commands.some(commandFailed)
  );
}

function commandFailed(command: StageReportCommand) {
  return command.status === "failed" || (command.exit_code !== undefined && command.exit_code !== 0);
}

function descriptionFromReports(reports: StageInputReport[]) {
  return [
    "## Summary",
    `Generated from ${reports.length} workflow stage reports.`,
    "",
    "## Changes",
    ...changedFileLines(reports),
    "",
    "## Validation",
    ...validationLines(reports),
    "",
    "## Findings",
    ...findingLines(collectFindings(reports)),
    "",
    "## Notes",
    "- Manual paste target: GitHub or GitLab MR/PR title and description.",
    `- ${NO_EXTERNAL_ACTION_NOTE}`
  ].join("\n") + "\n";
}

function blockedDescription(blockers: StageReportBlocker[]) {
  return [
    "## Summary",
    "MR preparation could not start because required workflow evidence is missing.",
    "",
    "## Blockers",
    ...blockers.map((blocker) => `- ${blocker.message}`),
    "",
    "## Notes",
    "- Manual paste target: GitHub or GitLab MR/PR title and description.",
    `- ${NO_EXTERNAL_ACTION_NOTE}`
  ].join("\n") + "\n";
}

function changedFileLines(reports: StageInputReport[]) {
  const changedFiles = [...new Set(reports.flatMap((priorReport) => priorReport.report.changed_files))].sort();

  if (changedFiles.length === 0) {
    return ["- No changed files were recorded."];
  }

  return changedFiles.map((filePath) => `- ${filePath}`);
}

function validationLines(reports: StageInputReport[]) {
  return reports.flatMap((priorReport) => {
    const report = priorReport.report;
    const lines = [`- ${priorReport.stageId}: ${report.status} - ${report.summary}`];

    for (const command of report.commands) {
      lines.push(`  - ${command.command}: ${command.status}${command.summary ? ` - ${command.summary}` : ""}`);
    }

    for (const skipped of report.skipped) {
      lines.push(`  - skipped${skipped.id ? ` ${skipped.id}` : ""}: ${skipped.reason}`);
    }

    for (const blocker of report.blockers ?? []) {
      lines.push(`  - blocker: ${blocker.message}`);
    }

    return lines;
  });
}

function findingLines(findings: Record<string, unknown>[]) {
  if (findings.length === 0) {
    return ["- No findings were recorded."];
  }

  return findings.map((finding) => {
    const stageId = stringField(finding, "stage_id") ?? "unknown_stage";
    const severity = stringField(finding, "severity") ?? "unspecified";
    const rootCause = stringField(finding, "root_cause") ?? stringField(finding, "id");
    const message = stringField(finding, "message") ?? stringField(finding, "summary") ?? "Finding recorded.";
    const label = rootCause ? `${rootCause}: ` : "";

    return `- [${severity}] ${stageId}: ${label}${message}`;
  });
}

function collectFindings(reports: StageInputReport[]): Record<string, unknown>[] {
  return reports.flatMap((priorReport) =>
    priorReport.report.findings.map((finding) => ({
      ...finding,
      stage_id: priorReport.stageId
    }))
  );
}

function stringField(record: Record<string, unknown>, fieldName: string) {
  const value = record[fieldName];
  return typeof value === "string" && value.trim() ? value : undefined;
}
