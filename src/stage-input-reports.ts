import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseStageReport, type StageReport, type StageReportBlocker } from "./stage-report.js";
import type { RunStageState, StageExecutionContext, WorkflowInput } from "./types.js";

export interface StageInputReport {
  inputId: string;
  stageId: string;
  path: string;
  report: StageReport;
}

export async function readRequiredStageInputReports(context: StageExecutionContext) {
  const reports: StageInputReport[] = [];
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
