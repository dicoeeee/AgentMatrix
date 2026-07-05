import { execFile, type ExecFileException } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { writeProjectJson } from "./project-files.js";
import type { StageReport } from "./stage-report.js";
import type {
  StageExecutionContext,
  StageVerificationContext,
  WorkflowOutput,
  WorkflowRuntimeAdapter
} from "./types.js";

export interface OpencodeRuntimeOptions {
  executable?: string;
  model?: string;
  attach?: string;
  autoApprove?: boolean;
  timeoutMs?: number;
}

interface OpencodeCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface VerifierEvidence {
  accepted?: unknown;
}

const DEFAULT_OPENCODE_EXECUTABLE = "opencode";
const DEFAULT_OPENCODE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_BUFFER = 20 * 1024 * 1024;

export function createOpencodeRuntimeAdapter(options: OpencodeRuntimeOptions = {}): WorkflowRuntimeAdapter {
  const executable = options.executable ?? DEFAULT_OPENCODE_EXECUTABLE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCODE_TIMEOUT_MS;

  return {
    async executeStage(context) {
      const prompt = stageExecutionPrompt(context);
      const result = await runOpencode({
        executable,
        projectRoot: context.projectRoot,
        agentRole: context.stage.agentRole,
        prompt,
        title: `AgentMatrix ${context.runState.id} ${context.stage.id}`,
        model: options.model,
        attach: options.attach,
        autoApprove: options.autoApprove,
        timeoutMs
      });

      if (result.exitCode !== 0 || !(await pathExists(context.projectRoot, context.stageReportPath))) {
        await writeFallbackStageReport(context, result);
      }

      if (!(await pathExists(context.projectRoot, context.executorEvidencePath))) {
        await writeProjectJson(context.projectRoot, context.executorEvidencePath, {
          schema_version: 1,
          run_id: context.runState.id,
          stage_id: context.stage.id,
          agent_role: context.stage.agentRole,
          status: result.exitCode === 0 ? "success" : "failed",
          command: result.command,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          stage_report_path: context.stageReportPath
        });
      }

      return {
        stageReportPath: context.stageReportPath,
        evidencePath: context.executorEvidencePath
      };
    },

    async verifyStage(context) {
      const prompt = stageVerificationPrompt(context);
      const result = await runOpencode({
        executable,
        projectRoot: context.projectRoot,
        agentRole: context.stage.verifierRole,
        prompt,
        title: `AgentMatrix ${context.runState.id} ${context.stage.id} verifier`,
        model: options.model,
        attach: options.attach,
        autoApprove: options.autoApprove,
        timeoutMs
      });
      const evidence = await readVerifierEvidence(context, result);

      return {
        accepted: result.exitCode === 0 && evidence.accepted === true,
        evidencePath: context.verifierEvidencePath
      };
    }
  };
}

function stageExecutionPrompt(context: StageExecutionContext) {
  return [
    `You are the OpenCode execution agent for AgentMatrix stage "${context.stage.id}".`,
    "",
    "Execute exactly this workflow stage in the current project directory.",
    "Write every required stage output before finishing.",
    "The stage_report output must be valid JSON matching AgentMatrix's stage_report schema.",
    "Do not create or submit an MR/PR, push branches, assign reviewers, change labels, or watch CI.",
    "If the stage is blocked, write a failed stage_report with blockers instead of only explaining the blocker.",
    "",
    "AGENTMATRIX_CONTEXT_JSON",
    JSON.stringify(stageExecutionSpec(context), null, 2),
    "END_AGENTMATRIX_CONTEXT_JSON"
  ].join("\n");
}

function stageVerificationPrompt(context: StageVerificationContext) {
  return [
    `You are the OpenCode verifier agent for AgentMatrix stage "${context.stage.id}".`,
    "",
    "Verify the declared stage report, outputs, and completion criteria.",
    "Write the verifier evidence JSON before finishing.",
    "Set accepted to true only when the stage evidence satisfies the declared criteria.",
    "Do not edit project source files or stage outputs; only write the verifier evidence file.",
    "",
    "AGENTMATRIX_CONTEXT_JSON",
    JSON.stringify(stageVerificationSpec(context), null, 2),
    "END_AGENTMATRIX_CONTEXT_JSON"
  ].join("\n");
}

function stageExecutionSpec(context: StageExecutionContext) {
  return {
    schema_version: 1,
    kind: "stage_execution",
    run_id: context.runState.id,
    workflow_id: context.runState.workflowId,
    stage: stageSpec(context.stage),
    stage_report_path: context.stageReportPath,
    executor_evidence_path: context.executorEvidencePath,
    outputs: outputSpecs(context.runState.artifactPath, context.stage.outputs),
    inputs: context.stage.inputs,
    completion_criteria: context.stage.completionCriteria,
    repair_policy: context.stage.repairPolicy,
    rerun_when: context.stage.rerunWhen
  };
}

function stageVerificationSpec(context: StageVerificationContext) {
  return {
    schema_version: 1,
    kind: "stage_verification",
    run_id: context.runState.id,
    workflow_id: context.runState.workflowId,
    stage: stageSpec(context.stage),
    stage_report_path: context.stageReportPath,
    verifier_evidence_path: context.verifierEvidencePath,
    outputs: outputSpecs(context.runState.artifactPath, context.stage.outputs),
    completion_criteria: context.stage.completionCriteria
  };
}

function stageSpec(stage: StageExecutionContext["stage"]) {
  return {
    id: stage.id,
    name: stage.name,
    depends_on: stage.dependsOn,
    agent_role: stage.agentRole,
    verifier_role: stage.verifierRole,
    skills: stage.skills,
    mcp_resources: stage.mcpResources
  };
}

function outputSpecs(artifactPath: string, outputs: WorkflowOutput[]) {
  return outputs.map((output) => ({
    id: output.id,
    path: normalizeRelativePath(path.join(artifactPath, output.path)),
    required: output.required,
    ...(output.schema ? { schema: output.schema } : {})
  }));
}

async function runOpencode(options: {
  executable: string;
  projectRoot: string;
  agentRole: string;
  prompt: string;
  title: string;
  model?: string;
  attach?: string;
  autoApprove?: boolean;
  timeoutMs: number;
}): Promise<OpencodeCommandResult> {
  const args = [
    "run",
    "--dir",
    options.projectRoot,
    "--agent",
    options.agentRole,
    "--format",
    "json",
    "--title",
    options.title
  ];

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.attach) {
    args.push("--attach", options.attach);
  }
  if (options.autoApprove) {
    args.push("--auto");
  }

  args.push(options.prompt);

  return new Promise((resolve) => {
    execFile(
      options.executable,
      args,
      {
        cwd: options.projectRoot,
        timeout: options.timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        resolve({
          command: formatCommand(options.executable, args),
          exitCode: exitCodeFromError(error),
          stdout: stringifyOutput(stdout),
          stderr: commandErrorMessage(error, stderr)
        });
      }
    );
  });
}

async function writeFallbackStageReport(context: StageExecutionContext, result: OpencodeCommandResult) {
  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status: "failed",
    summary:
      result.exitCode === 0
        ? `OpenCode agent ${context.stage.agentRole} did not create required stage report ${context.stageReportPath}.`
        : `OpenCode agent ${context.stage.agentRole} failed before producing accepted stage evidence.`,
    commands: [
      {
        name: "OpenCode stage agent",
        command: `opencode run --agent ${context.stage.agentRole}`,
        status: "failed",
        exit_code: result.exitCode,
        summary: firstOutputLine(result.stderr) ?? firstOutputLine(result.stdout) ?? "OpenCode stage execution failed."
      }
    ],
    findings: [
      {
        severity: "blocker",
        source: "opencode",
        message:
          firstOutputLine(result.stderr) ??
          firstOutputLine(result.stdout) ??
          `OpenCode agent ${context.stage.agentRole} did not complete the stage.`
      }
    ],
    artifacts: [context.stageReportPath],
    skipped: [],
    changed_files: [],
    blockers: []
  };

  await writeProjectJson(context.projectRoot, context.stageReportPath, report);
}

async function readVerifierEvidence(
  context: StageVerificationContext,
  result: OpencodeCommandResult
): Promise<VerifierEvidence> {
  if (result.exitCode === 0 && (await pathExists(context.projectRoot, context.verifierEvidencePath))) {
    try {
      return JSON.parse(
        await readFile(path.join(context.projectRoot, context.verifierEvidencePath), "utf8")
      ) as VerifierEvidence;
    } catch {
      // Fall through and replace invalid verifier output with adapter evidence.
    }
  }

  const accepted = false;
  await writeProjectJson(context.projectRoot, context.verifierEvidencePath, {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    verifier_role: context.stage.verifierRole,
    accepted,
    command: result.command,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    checked_artifact: context.stageReportPath,
    summary:
      result.exitCode === 0
        ? `Verifier ${context.stage.verifierRole} did not write valid accepted evidence.`
        : `Verifier ${context.stage.verifierRole} failed.`
  });

  return { accepted };
}

async function pathExists(projectRoot: string, relativePath: string) {
  try {
    await access(path.join(projectRoot, relativePath));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function normalizeRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}

function exitCodeFromError(error: ExecFileException | null) {
  if (!error) {
    return 0;
  }

  return typeof error.code === "number" ? error.code : 1;
}

function stringifyOutput(output: string | Buffer) {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function commandErrorMessage(error: ExecFileException | null, stderr: string | Buffer) {
  const output = stringifyOutput(stderr);
  if (output) {
    return output;
  }

  if (hasErrorCode(error, "ENOENT")) {
    return "OpenCode executable was not found. Install OpenCode or pass --opencode-bin with the executable path.";
  }

  return error?.message ?? "";
}

function formatCommand(executable: string, args: string[]) {
  return [executable, ...args.slice(0, -1), "<prompt>"].join(" ");
}

function firstOutputLine(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
