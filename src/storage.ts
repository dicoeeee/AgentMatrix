import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentMatrixError } from "./errors.js";
import {
  assertWorkflowResourcesAvailable,
  availableResourceProvider,
  availableResourcesFromWorkflow,
  normalizeAvailableResources,
  type ResourceProvider
} from "./resources.js";
import {
  DEFAULT_WORKFLOW_FILE,
  DEFAULT_WORKFLOW_ID,
  DEFAULT_WORKFLOW_YAML,
  isBuiltInWorkflowId
} from "./templates.js";
import {
  AGENTMATRIX_DIR,
  type RunStageState,
  type RunState,
  type RerunTrigger,
  type StageExecutionContext,
  type StageFailureMetadata,
  type StageVerificationContext,
  type WorkflowDefinition,
  type WorkflowRuntimeAdapter
} from "./types.js";
import {
  failedCommand,
  firstBlocker,
  hasSkipReason,
  parseStageReport,
  type StageReport,
  type StageReportBlocker,
  type StageReportCommand
} from "./stage-report.js";
import { parseWorkflow } from "./workflow.js";

const CONFIG_FILE = "config.json";
const RUN_STATE_FILE = "run.json";

export interface InitResult {
  projectRoot: string;
  workflowPath: string;
  workflowCreated: boolean;
}

export interface RuntimeOptions {
  resourceProvider?: ResourceProvider;
  runtimeAdapter?: WorkflowRuntimeAdapter;
}

interface ProjectConfig {
  availableResources?: unknown;
}

export async function initializeProject(projectRoot: string, workflowId = DEFAULT_WORKFLOW_ID): Promise<InitResult> {
  assertBuiltInWorkflow(workflowId);
  const paths = projectPaths(projectRoot);
  const workflow = parseWorkflow(DEFAULT_WORKFLOW_YAML, DEFAULT_WORKFLOW_FILE);

  await mkdir(paths.workflowsDir, { recursive: true });
  await mkdir(paths.runsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });

  await writeFileIfAbsent(
    paths.configPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        defaultWorkflow: workflowId,
        workflowsDir: "workflows",
        runsDir: "runs",
        artifactsDir: "artifacts",
        availableResources: availableResourcesFromWorkflow(workflow)
      },
      null,
      2
    ) + "\n"
  );

  const workflowCreated = await writeFileIfAbsent(paths.defaultWorkflowPath, DEFAULT_WORKFLOW_YAML);

  return {
    projectRoot: paths.projectRoot,
    workflowPath: paths.defaultWorkflowPath,
    workflowCreated
  };
}

export async function createRun(
  projectRoot: string,
  workflowId = DEFAULT_WORKFLOW_ID,
  options: RuntimeOptions = {}
): Promise<RunState> {
  const paths = projectPaths(projectRoot);
  const workflow = await loadWorkflow(paths.projectRoot, workflowId);
  await assertWorkflowResourcesAvailable(workflow, options.resourceProvider ?? (await loadProjectResourceProvider(paths)));
  if (!options.runtimeAdapter) {
    throw new AgentMatrixError("Workflow execution adapter is not configured.");
  }

  const runId = createRunId();
  const runDir = path.join(paths.runsDir, runId);
  const artifactDir = path.join(paths.artifactsDir, runId);
  const now = new Date().toISOString();

  await mkdir(runDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });

  const runState: RunState = {
    schemaVersion: 1,
    id: runId,
    workflowId: workflow.id,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    workflowPath: toProjectRelative(paths.projectRoot, workflowPath(paths.projectRoot, workflow.id)),
    artifactPath: toProjectRelative(paths.projectRoot, artifactDir),
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      status: "pending",
      dependsOn: stage.dependsOn,
      inputs: stage.inputs,
      outputs: stage.outputs,
      completionCriteria: stage.completionCriteria,
      repairPolicy: stage.repairPolicy,
      rerunWhen: stage.rerunWhen,
      mcpResources: stage.mcpResources,
      agentRole: stage.agentRole,
      verifierRole: stage.verifierRole,
      skills: stage.skills,
      evidence: [],
      artifacts: []
    })),
    events: [
      {
        at: now,
        type: "run_created",
        message: "Run created by agentmatrix run."
      }
    ]
  };

  await writeRun(paths.projectRoot, runState);
  return executeFreshRun(paths.projectRoot, runState, options.runtimeAdapter);
}

export async function resumeRun(
  projectRoot: string,
  runId?: string,
  options: RuntimeOptions = {}
): Promise<RunState> {
  const paths = projectPaths(projectRoot);
  const runState = runId ? await readRun(paths.projectRoot, runId) : await readLatestResumableRun(paths.projectRoot);
  const workflow = await loadWorkflow(paths.projectRoot, runState.workflowId);
  await assertWorkflowResourcesAvailable(workflow, options.resourceProvider ?? (await loadProjectResourceProvider(paths)));
  assertRunResumable(runState);
  if (!options.runtimeAdapter) {
    throw new AgentMatrixError("Workflow execution adapter is not configured.");
  }

  updateRun(runState, "running");
  runState.events.push({
    at: runState.updatedAt,
    type: "resume_requested",
    message: "Resume requested; continuing workflow run."
  });
  await writeRun(paths.projectRoot, runState);

  await executeStages(paths.projectRoot, runState, options.runtimeAdapter);
  await completeRun(paths.projectRoot, runState, "Workflow run completed after resume.");

  return runState;
}

export async function readRuns(projectRoot: string): Promise<RunState[]> {
  const paths = projectPaths(projectRoot);
  if (!(await pathExists(paths.runsDir))) {
    return [];
  }

  const entries = await readdir(paths.runsDir);
  const runs: RunState[] = [];

  for (const entry of entries) {
    const runPath = path.join(paths.runsDir, entry, RUN_STATE_FILE);
    if (await pathExists(runPath)) {
      const source = await readFile(runPath, "utf8");
      runs.push(JSON.parse(source) as RunState);
    }
  }

  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readRunForDisplay(projectRoot: string, runId?: string): Promise<RunState> {
  if (runId) {
    return readRun(projectRoot, runId);
  }

  const runs = await readRuns(projectRoot);
  const latest = runs[0];
  if (!latest) {
    throw new AgentMatrixError("No AgentMatrix runs found.");
  }
  return latest;
}

export async function readWorkflowForDisplay(
  projectRoot: string,
  workflowId = DEFAULT_WORKFLOW_ID
): Promise<WorkflowDefinition> {
  const paths = projectPaths(projectRoot);
  return loadWorkflow(paths.projectRoot, workflowId);
}

export async function validateWorkflowFile(projectRoot: string, workflowId = DEFAULT_WORKFLOW_ID): Promise<void> {
  await loadWorkflow(projectRoot, workflowId);
}

export function projectPaths(projectRoot: string) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const agentDir = path.join(resolvedProjectRoot, AGENTMATRIX_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    agentDir,
    configPath: path.join(agentDir, CONFIG_FILE),
    workflowsDir: path.join(agentDir, "workflows"),
    defaultWorkflowPath: path.join(agentDir, "workflows", DEFAULT_WORKFLOW_FILE),
    runsDir: path.join(agentDir, "runs"),
    artifactsDir: path.join(agentDir, "artifacts")
  };
}

async function loadWorkflow(projectRoot: string, workflowId: string): Promise<WorkflowDefinition> {
  const filePath = workflowPath(projectRoot, workflowId);

  if (!(await pathExists(filePath))) {
    throw new AgentMatrixError(
      `Workflow "${workflowId}" was not found. Run \`agentmatrix init\` before starting a run.`
    );
  }

  return parseWorkflow(await readFile(filePath, "utf8"), filePath);
}

async function executeFreshRun(
  projectRoot: string,
  runState: RunState,
  runtimeAdapter: WorkflowRuntimeAdapter
): Promise<RunState> {
  updateRun(runState, "running");
  runState.events.push({
    at: runState.updatedAt,
    type: "run_started",
    message: "Fresh workflow run started."
  });
  await writeRun(projectRoot, runState);

  await executeStages(projectRoot, runState, runtimeAdapter);
  await completeRun(projectRoot, runState, "Fresh workflow run completed.");

  return runState;
}

async function executeStages(
  projectRoot: string,
  runState: RunState,
  runtimeAdapter: WorkflowRuntimeAdapter
) {
  while (true) {
    const stage = runState.stages.find((candidate) => !isStageComplete(candidate));
    if (!stage) {
      return;
    }
    assertDependenciesSuccessful(runState, stage);
    await executeStage(projectRoot, runState, stage, runtimeAdapter);
  }
}

async function completeRun(projectRoot: string, runState: RunState, message: string) {
  updateRun(runState, "success");
  runState.events.push({
    at: runState.updatedAt,
    type: "run_completed",
    message
  });
  await writeRun(projectRoot, runState);
}

async function executeStage(
  projectRoot: string,
  runState: RunState,
  stage: RunStageState,
  runtimeAdapter: WorkflowRuntimeAdapter
) {
  const previouslySuccessfulStageIds = new Set(
    runState.stages.filter((candidate) => candidate.status === "success").map((candidate) => candidate.id)
  );
  updateStage(runState, stage, "running");
  runState.events.push({
    at: runState.updatedAt,
    type: "stage_started",
    stageId: stage.id,
    message: `Stage ${stage.id} started.`
  });
  await writeRun(projectRoot, runState);

  const stageReportPath = stageReportArtifactPath(runState, stage);
  const executorEvidencePath = artifactPath(runState, stage.id, "executor-evidence.json");
  const verifierEvidencePath = artifactPath(runState, stage.id, "verifier-evidence.json");
  const executionContext: StageExecutionContext = {
    projectRoot,
    runState,
    stage,
    stageReportPath,
    executorEvidencePath
  };

  const execution = await runtimeAdapter.executeStage(executionContext);

  stage.artifacts = await existingStageOutputPaths(projectRoot, runState, stage);
  stage.evidence = [execution.evidencePath];
  touchRun(runState);
  runState.events.push({
    at: runState.updatedAt,
    type: "stage_executor_completed",
    stageId: stage.id,
    message: `Mock executor completed stage ${stage.id}.`
  });
  await writeRun(projectRoot, runState);

  let stageReport: StageReport;
  try {
    stageReport = await readStageReport(projectRoot, stageReportPath);
    assertStageReportMatchesRun(stageReport, runState, stage, stageReportPath);
  } catch (error) {
    const failure = schemaFailure(error);
    await failStage(projectRoot, runState, stage, failure);
    throw new AgentMatrixError(failure.message);
  }

  const completionFailure =
    (await completionCriteriaFailure(projectRoot, runState, stage, stageReport)) ??
    skippedReportFailure(stage, stageReport) ??
    failedReportStatusFailure(stage, stageReport);

  if (completionFailure) {
    await failStage(projectRoot, runState, stage, completionFailure);
    throw new AgentMatrixError(completionFailure.message);
  }

  const verificationContext: StageVerificationContext = {
    projectRoot,
    runState,
    stage,
    stageReportPath,
    verifierEvidencePath
  };
  const verification = await runtimeAdapter.verifyStage(verificationContext);

  stage.evidence.push(verification.evidencePath);
  if (!verification.accepted) {
    const failure: StageFailureMetadata = {
      kind: "verifier_failure",
      message: `Verifier ${stage.verifierRole} rejected stage "${stage.id}".`,
      metadata: {
        verifierRole: stage.verifierRole,
        evidencePath: verification.evidencePath
      }
    };
    updateStage(runState, stage, "failed", failure);
    updateRun(runState, "failed");
    runState.events.push({
      at: runState.updatedAt,
      type: "stage_verified",
      stageId: stage.id,
      message: `Verifier ${stage.verifierRole} rejected stage ${stage.id}.`
    });
    await writeRun(projectRoot, runState);
    throw new AgentMatrixError(failure.message);
  }

  updateStage(runState, stage, stageReport.status === "skipped" ? "skipped" : "success");
  runState.events.push({
    at: runState.updatedAt,
    type: "stage_verified",
    stageId: stage.id,
    message: `Verifier ${stage.verifierRole} accepted stage ${stage.id}.`
  });
  invalidateStaleStages(runState, stageReport, previouslySuccessfulStageIds);
  await writeRun(projectRoot, runState);
}

async function readStageReport(projectRoot: string, relativePath: string): Promise<StageReport> {
  try {
    return parseStageReport(await readFile(path.join(projectRoot, relativePath), "utf8"), relativePath);
  } catch (error) {
    if (error instanceof AgentMatrixError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentMatrixError(
      `Stage report ${relativePath} is missing or unreadable for stage_report schema: ${detail}`
    );
  }
}

function assertStageReportMatchesRun(
  report: StageReport,
  runState: RunState,
  stage: RunStageState,
  label: string
) {
  if (report.run_id !== runState.id) {
    throw new AgentMatrixError(
      `Stage report ${label} failed stage_report schema: run_id must be "${runState.id}".`
    );
  }

  if (report.stage_id !== stage.id) {
    throw new AgentMatrixError(
      `Stage report ${label} failed stage_report schema: stage_id must be "${stage.id}".`
    );
  }
}

async function completionCriteriaFailure(
  projectRoot: string,
  runState: RunState,
  stage: RunStageState,
  stageReport: StageReport
): Promise<StageFailureMetadata | undefined> {
  for (const criterion of stage.completionCriteria) {
    if (criterion.type === "output_exists") {
      const outputPath = outputArtifactPath(runState, stage, criterion.output);
      if (!(await pathExists(path.join(projectRoot, outputPath)))) {
        return {
          kind: "missing_resource",
          message: `Stage "${stage.id}" required output "${criterion.output}" is missing at ${outputPath}.`,
          metadata: {
            output: criterion.output,
            path: outputPath
          }
        };
      }
      continue;
    }

    if (criterion.type === "schema_valid") {
      const outputPath = outputArtifactPath(runState, stage, criterion.output);
      try {
        if (criterion.schema === "stage_report") {
          const report =
            criterion.output === "stage_report"
              ? stageReport
              : await readStageReport(projectRoot, outputPath);
          assertStageReportMatchesRun(report, runState, stage, outputPath);
        }
      } catch (error) {
        return schemaFailure(error);
      }
      continue;
    }

    if (criterion.type === "commands_ok") {
      const command = failedCommand(stageReport);
      if (command) {
        return commandFailure(stage, command);
      }
      continue;
    }

    if (criterion.type === "no_blockers") {
      const blocker = firstBlocker(stageReport);
      if (blocker) {
        return blockerFailure(stage, blocker);
      }
      continue;
    }

    if (criterion.type === "skip_reason_present") {
      const failure = skippedReportFailure(stage, stageReport);
      if (failure) {
        return failure;
      }
    }
  }

  return undefined;
}

function commandFailure(stage: RunStageState, command: StageReportCommand): StageFailureMetadata {
  const message = `Stage "${stage.id}" command failed: ${command.command}.`;

  return {
    kind: "command_failure",
    message,
    metadata: {
      command: command.command,
      ...(command.exit_code === undefined ? {} : { exitCode: command.exit_code })
    }
  };
}

function blockerFailure(stage: RunStageState, blocker: StageReportBlocker): StageFailureMetadata {
  const kindByBlockerType = {
    missing_resource: "missing_resource",
    human_required: "human_required_blocker",
    external_required: "external_required_blocker"
  } as const;

  return {
    kind: kindByBlockerType[blocker.type],
    message: `Stage "${stage.id}" reported blocker: ${blocker.message}.`,
    metadata: {
      blockerType: blocker.type,
      blockerMessage: blocker.message,
      ...(blocker.resource ? { resource: blocker.resource } : {})
    }
  };
}

function skippedReportFailure(stage: RunStageState, stageReport: StageReport): StageFailureMetadata | undefined {
  if (stageReport.status !== "skipped" || hasSkipReason(stageReport)) {
    return undefined;
  }

  return {
    kind: "schema_failure",
    message: `Stage "${stage.id}" reported skipped without a skip reason.`
  };
}

function failedReportStatusFailure(stage: RunStageState, stageReport: StageReport): StageFailureMetadata | undefined {
  if (stageReport.status !== "failed") {
    return undefined;
  }

  const command = failedCommand(stageReport);
  if (command) {
    return commandFailure(stage, command);
  }

  const blocker = firstBlocker(stageReport);
  if (blocker) {
    return blockerFailure(stage, blocker);
  }

  return {
    kind: "stage_report_failure",
    message: `Stage "${stage.id}" reported failed.`
  };
}

function schemaFailure(error: unknown): StageFailureMetadata {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "schema_failure",
    message
  };
}

async function failStage(
  projectRoot: string,
  runState: RunState,
  stage: RunStageState,
  failure: StageFailureMetadata
) {
  updateStage(runState, stage, "failed", failure);
  updateRun(runState, "failed");
  await writeRun(projectRoot, runState);
}

function invalidateStaleStages(
  runState: RunState,
  stageReport: StageReport,
  previouslySuccessfulStageIds: Set<string>
) {
  const changedFiles = normalizePathList(stageReport.changed_files);
  const changedArtifacts = changedArtifactPathList(runState, stageReport.changed_artifacts ?? []);

  if (changedFiles.length === 0 && changedArtifacts.length === 0) {
    return;
  }

  const invalidatedStageIds = new Set<string>();

  for (const stage of runState.stages) {
    if (!previouslySuccessfulStageIds.has(stage.id)) {
      continue;
    }

    if (rerunTriggersMatch(stage.rerunWhen, changedFiles, changedArtifacts)) {
      markStagePending(runState, stage);
      invalidatedStageIds.add(stage.id);
    }
  }

  propagatePendingToDependents(runState, invalidatedStageIds);
}

function propagatePendingToDependents(runState: RunState, invalidatedStageIds: Set<string>) {
  let changed = true;

  while (changed) {
    changed = false;
    for (const stage of runState.stages) {
      if (stage.status !== "success" || invalidatedStageIds.has(stage.id)) {
        continue;
      }

      if (stage.dependsOn.some((dependencyId) => invalidatedStageIds.has(dependencyId))) {
        markStagePending(runState, stage);
        invalidatedStageIds.add(stage.id);
        changed = true;
      }
    }
  }
}

function markStagePending(runState: RunState, stage: RunStageState) {
  updateStage(runState, stage, "pending");
  stage.evidence = [];
  stage.artifacts = [];
}

function rerunTriggersMatch(triggers: RerunTrigger[], changedFiles: string[], changedArtifacts: string[]) {
  return triggers.some((trigger) => {
    const candidates = trigger.type === "changed_files" ? changedFiles : changedArtifacts;
    const patterns = trigger.type === "changed_files" ? trigger.paths : trigger.artifacts;
    return candidates.some((candidate) => patterns.some((pattern) => pathPatternMatches(pattern, candidate)));
  });
}

function changedArtifactPathList(runState: RunState, changedArtifacts: string[]) {
  const artifactRoot = normalizeWorkflowPath(runState.artifactPath);
  const paths = new Set<string>();

  for (const artifact of changedArtifacts) {
    const normalized = normalizeWorkflowPath(artifact);
    if (!normalized) {
      continue;
    }

    paths.add(normalized);
    if (artifactRoot && normalized.startsWith(`${artifactRoot}/`)) {
      paths.add(normalized.slice(artifactRoot.length + 1));
    }
  }

  return [...paths];
}

function normalizePathList(paths: string[]) {
  return [...new Set(paths.map(normalizeWorkflowPath).filter(Boolean))];
}

function normalizeWorkflowPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function pathPatternMatches(pattern: string, candidate: string) {
  const normalizedPattern = normalizeWorkflowPath(pattern);
  const normalizedCandidate = normalizeWorkflowPath(candidate);

  if (!normalizedPattern || !normalizedCandidate) {
    return false;
  }

  if (hasUnsupportedGlobSyntax(normalizedPattern)) {
    return true;
  }

  if (!hasGlobSyntax(normalizedPattern)) {
    const directoryPattern = normalizedPattern.replace(/\/+$/, "");
    return normalizedCandidate === normalizedPattern || normalizedCandidate.startsWith(`${directoryPattern}/`);
  }

  return globToRegExp(normalizedPattern).test(normalizedCandidate);
}

function hasGlobSyntax(pattern: string) {
  return pattern.includes("*");
}

function hasUnsupportedGlobSyntax(pattern: string) {
  return /[\[\]{}?!]/.test(pattern);
}

function globToRegExp(pattern: string) {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    source += escapeRegExp(character);
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function assertDependenciesSuccessful(runState: RunState, stage: RunStageState) {
  for (const dependencyId of stage.dependsOn) {
    const dependency = runState.stages.find((candidate) => candidate.id === dependencyId);
    if (!dependency || (dependency.status !== "success" && dependency.status !== "skipped")) {
      throw new AgentMatrixError(`Stage "${stage.id}" cannot start before dependency "${dependencyId}" succeeds.`);
    }
  }
}

function isStageComplete(stage: RunStageState) {
  return stage.status === "success" || stage.status === "skipped";
}

function assertRunResumable(runState: RunState) {
  if (runState.status === "pending" || runState.status === "running" || runState.status === "failed") {
    return;
  }

  throw new AgentMatrixError(`Run "${runState.id}" is not resumable because its status is "${runState.status}".`);
}

function stageReportArtifactPath(runState: RunState, stage: RunStageState) {
  return outputArtifactPath(runState, stage, "stage_report");
}

function outputArtifactPath(runState: RunState, stage: RunStageState, outputId?: string) {
  if (!outputId) {
    throw new AgentMatrixError(`Stage "${stage.id}" completion criterion is missing an output id.`);
  }

  const output = stage.outputs.find((candidate) => candidate.id === outputId);
  if (!output) {
    throw new AgentMatrixError(`Stage "${stage.id}" does not declare output "${outputId}".`);
  }

  return path.join(runState.artifactPath, output.path);
}

async function existingStageOutputPaths(projectRoot: string, runState: RunState, stage: RunStageState) {
  const outputPaths: string[] = [];

  for (const output of stage.outputs) {
    const outputPath = path.join(runState.artifactPath, output.path);
    if (await pathExists(path.join(projectRoot, outputPath))) {
      outputPaths.push(outputPath);
    }
  }

  return outputPaths;
}

function artifactPath(runState: RunState, stageId: string, fileName: string) {
  return path.join(runState.artifactPath, stageId, fileName);
}

function updateStage(
  runState: RunState,
  stage: RunStageState,
  status: RunStageState["status"],
  failure?: StageFailureMetadata
) {
  stage.status = status;
  if (failure) {
    stage.failure = failure;
  } else if (status !== "failed") {
    delete stage.failure;
  }
  touchRun(runState);
}

function updateRun(runState: RunState, status: RunState["status"]) {
  runState.status = status;
  touchRun(runState);
}

function touchRun(runState: RunState) {
  runState.updatedAt = new Date().toISOString();
}

async function loadProjectResourceProvider(paths: ReturnType<typeof projectPaths>): Promise<ResourceProvider> {
  const config = await readProjectConfig(paths.configPath);
  return availableResourceProvider(normalizeAvailableResources(config.availableResources));
}

async function readProjectConfig(configPath: string): Promise<ProjectConfig> {
  if (!(await pathExists(configPath))) {
    throw new AgentMatrixError("AgentMatrix config was not found. Run `agentmatrix init` before starting a run.");
  }

  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof config === "object" && config !== null && !Array.isArray(config)) {
      return config as ProjectConfig;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentMatrixError(`Invalid AgentMatrix config JSON in ${configPath}: ${detail}`);
  }

  throw new AgentMatrixError(`AgentMatrix config ${configPath} must be a JSON object.`);
}

async function readLatestResumableRun(projectRoot: string): Promise<RunState> {
  const runs = await readRuns(projectRoot);
  const run = runs.find(
    (candidate) => candidate.status === "pending" || candidate.status === "running" || candidate.status === "failed"
  );

  if (!run) {
    throw new AgentMatrixError("No resumable runs found.");
  }

  return run;
}

async function readRun(projectRoot: string, runId: string): Promise<RunState> {
  const paths = projectPaths(projectRoot);
  const runPath = path.join(paths.runsDir, runId, RUN_STATE_FILE);

  if (!(await pathExists(runPath))) {
    throw new AgentMatrixError(`Run "${runId}" was not found.`);
  }

  return JSON.parse(await readFile(runPath, "utf8")) as RunState;
}

async function writeRun(projectRoot: string, runState: RunState) {
  const paths = projectPaths(projectRoot);
  const runDir = path.join(paths.runsDir, runState.id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, RUN_STATE_FILE), JSON.stringify(runState, null, 2) + "\n");
}

function workflowPath(projectRoot: string, workflowId: string) {
  if (workflowId !== DEFAULT_WORKFLOW_ID) {
    throw new AgentMatrixError(`Workflow "${workflowId}" is not available in this foundation slice.`);
  }

  return projectPaths(projectRoot).defaultWorkflowPath;
}

function assertBuiltInWorkflow(workflowId: string) {
  if (!isBuiltInWorkflowId(workflowId)) {
    throw new AgentMatrixError(`Workflow template "${workflowId}" is not available.`);
  }
}

function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

async function writeFileIfAbsent(filePath: string, data: string) {
  try {
    await writeFile(filePath, data, { flag: "wx" });
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function toProjectRelative(projectRoot: string, filePath: string) {
  return path.relative(projectRoot, filePath);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
