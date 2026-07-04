import type { CompletionCriterionType, RerunTriggerType } from "./workflow-constants.js";

export const AGENTMATRIX_DIR = ".agentmatrix";

export type StageStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type RunStatus = "pending" | "running" | "success" | "failed";

export interface StageDefinitionFields {
  id: string;
  name: string;
  dependsOn: string[];
  inputs: WorkflowInput[];
  outputs: WorkflowOutput[];
  completionCriteria: CompletionCriterion[];
  repairPolicy: RepairPolicy;
  rerunWhen: RerunTrigger[];
  mcpResources: string[];
  agentRole: string;
  verifierRole: string;
  skills: string[];
}

export interface WorkflowStage extends StageDefinitionFields {}

export interface WorkflowInput {
  id: string;
  required: boolean;
  sourceStage?: string;
  output?: string;
}

export interface WorkflowOutput {
  id: string;
  path: string;
  required: boolean;
  schema?: string;
}

export interface CompletionCriterion {
  type: CompletionCriterionType;
  output?: string;
  schema?: string;
}

export interface RepairPolicy {
  allowRepair: boolean;
  maxAttempts: number;
  writesAllowed: boolean;
}

export interface RerunTrigger {
  type: RerunTriggerType;
  paths: string[];
  artifacts: string[];
}

export interface WorkflowDefinition {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  stages: WorkflowStage[];
}

export interface RunStageState extends StageDefinitionFields {
  status: StageStatus;
  evidence: string[];
  artifacts: string[];
}

export type RunEventType =
  | "run_created"
  | "run_started"
  | "stage_started"
  | "stage_executor_completed"
  | "stage_verified"
  | "run_completed"
  | "resume_requested";

export interface RunEvent {
  at: string;
  type: RunEventType;
  message: string;
  stageId?: string;
}

export interface RunState {
  schemaVersion: number;
  id: string;
  workflowId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  workflowPath: string;
  artifactPath: string;
  stages: RunStageState[];
  events: RunEvent[];
}

export interface StageExecutionContext {
  projectRoot: string;
  runState: RunState;
  stage: RunStageState;
  stageReportPath: string;
  executorEvidencePath: string;
}

export interface StageExecutionResult {
  stageReportPath: string;
  evidencePath: string;
}

export interface StageVerificationContext {
  projectRoot: string;
  runState: RunState;
  stage: RunStageState;
  stageReportPath: string;
  verifierEvidencePath: string;
}

export interface StageVerificationResult {
  accepted: boolean;
  evidencePath: string;
}

export interface WorkflowRuntimeAdapter {
  executeStage(context: StageExecutionContext): Promise<StageExecutionResult>;
  verifyStage(context: StageVerificationContext): Promise<StageVerificationResult>;
}

export interface GraphNode {
  id: string;
  status: StageStatus;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface RunGraph {
  runId: string;
  workflowId: string;
  status: RunStatus;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
