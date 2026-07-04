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
  type StageExecutionContext,
  type StageVerificationContext,
  type WorkflowDefinition,
  type WorkflowRuntimeAdapter
} from "./types.js";
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
  const now = new Date().toISOString();

  runState.updatedAt = now;
  runState.events.push({
    at: now,
    type: "resume_requested",
    message: "Resume requested; execution adapters are not implemented in this foundation slice."
  });

  await writeRun(paths.projectRoot, runState);
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

  for (const stage of runState.stages) {
    assertDependenciesSuccessful(runState, stage);
    await executeStage(projectRoot, runState, stage, runtimeAdapter);
  }

  updateRun(runState, "success");
  runState.events.push({
    at: runState.updatedAt,
    type: "run_completed",
    message: "Fresh workflow run completed."
  });
  await writeRun(projectRoot, runState);

  return runState;
}

async function executeStage(
  projectRoot: string,
  runState: RunState,
  stage: RunStageState,
  runtimeAdapter: WorkflowRuntimeAdapter
) {
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

  stage.artifacts = [execution.stageReportPath];
  stage.evidence = [execution.evidencePath];
  touchRun(runState);
  runState.events.push({
    at: runState.updatedAt,
    type: "stage_executor_completed",
    stageId: stage.id,
    message: `Mock executor completed stage ${stage.id}.`
  });
  await writeRun(projectRoot, runState);

  const verificationContext: StageVerificationContext = {
    projectRoot,
    runState,
    stage,
    stageReportPath: execution.stageReportPath,
    verifierEvidencePath
  };
  const verification = await runtimeAdapter.verifyStage(verificationContext);

  stage.evidence.push(verification.evidencePath);
  if (!verification.accepted) {
    updateStage(runState, stage, "failed");
    runState.status = "failed";
    runState.events.push({
      at: runState.updatedAt,
      type: "stage_verified",
      stageId: stage.id,
      message: `Verifier ${stage.verifierRole} rejected stage ${stage.id}.`
    });
    await writeRun(projectRoot, runState);
    throw new AgentMatrixError(`Verifier ${stage.verifierRole} rejected stage "${stage.id}".`);
  }

  updateStage(runState, stage, "success");
  runState.events.push({
    at: runState.updatedAt,
    type: "stage_verified",
    stageId: stage.id,
    message: `Verifier ${stage.verifierRole} accepted stage ${stage.id}.`
  });
  await writeRun(projectRoot, runState);
}

function assertDependenciesSuccessful(runState: RunState, stage: RunStageState) {
  for (const dependencyId of stage.dependsOn) {
    const dependency = runState.stages.find((candidate) => candidate.id === dependencyId);
    if (!dependency || dependency.status !== "success") {
      throw new AgentMatrixError(`Stage "${stage.id}" cannot start before dependency "${dependencyId}" succeeds.`);
    }
  }
}

function stageReportArtifactPath(runState: RunState, stage: RunStageState) {
  const stageReport = stage.outputs.find((output) => output.id === "stage_report");
  if (!stageReport) {
    throw new AgentMatrixError(`Stage "${stage.id}" does not declare a stage_report output.`);
  }

  return path.join(runState.artifactPath, stageReport.path);
}

function artifactPath(runState: RunState, stageId: string, fileName: string) {
  return path.join(runState.artifactPath, stageId, fileName);
}

function updateStage(runState: RunState, stage: RunStageState, status: RunStageState["status"]) {
  stage.status = status;
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
  const run = runs.find((candidate) => candidate.status === "pending" || candidate.status === "running");

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
