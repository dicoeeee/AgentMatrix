import { parse } from "yaml";

import { AgentMatrixError } from "./errors.js";
import type {
  CompletionCriterion,
  RepairPolicy,
  RerunTrigger,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowOutput,
  WorkflowStage
} from "./types.js";

export function parseWorkflow(source: string, sourceName: string): WorkflowDefinition {
  let document: unknown;

  try {
    document = parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentMatrixError(`Invalid workflow YAML in ${sourceName}: ${detail}`);
  }

  if (!isRecord(document)) {
    throw new AgentMatrixError(`Workflow ${sourceName} must be a YAML object.`);
  }

  const schemaVersion = readNumber(document, "schema_version", sourceName);
  const id = readString(document, "id", sourceName);
  const name = readString(document, "name", sourceName);
  const description = readOptionalString(document, "description", sourceName);
  const stagesValue = document.stages;

  if (!Array.isArray(stagesValue) || stagesValue.length === 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} must define at least one stage.`);
  }

  const stages = stagesValue.map((stageValue, index) => parseWorkflowStage(stageValue, index, sourceName));
  assertUniqueStageIds(stages, sourceName);
  assertKnownDependencies(stages, sourceName);

  return {
    schemaVersion,
    id,
    name,
    ...(description ? { description } : {}),
    stages
  };
}

function parseWorkflowStage(stageValue: unknown, index: number, sourceName: string): WorkflowStage {
  if (!isRecord(stageValue)) {
    throw new AgentMatrixError(`Stage ${index + 1} in ${sourceName} must be a YAML object.`);
  }

  const id = readString(stageValue, "id", sourceName);
  const name = readOptionalString(stageValue, "name", sourceName) ?? id;
  const dependsOn = readStringArray(stageValue.depends_on ?? [], `depends_on for stage ${id}`, sourceName);
  const inputs = readInputs(stageValue.inputs, id, sourceName);
  const outputs = readOutputs(stageValue.outputs, id, sourceName);
  const completionCriteria = readCompletionCriteria(stageValue.completion_criteria, id, sourceName);
  const repairPolicy = readRepairPolicy(stageValue.repair_policy, id, sourceName);
  const rerunWhen = readRerunTriggers(stageValue.rerun_when, id, sourceName);
  const agentRole = readString(stageValue, "agent_role", sourceName);
  const verifierRole = readString(stageValue, "verifier_role", sourceName);
  const skills = readStringArray(stageValue.skills ?? [], `skills for stage ${id}`, sourceName);

  return {
    id,
    name,
    dependsOn,
    inputs,
    outputs,
    completionCriteria,
    repairPolicy,
    rerunWhen,
    agentRole,
    verifierRole,
    skills
  };
}

function readInputs(value: unknown, stageId: string, sourceName: string): WorkflowInput[] {
  return readRecordArray(value, `inputs for stage ${stageId}`, sourceName).map((input) => ({
    id: readString(input, "id", sourceName),
    required: readBoolean(input, "required", sourceName),
    ...readMappedOptionalString(input, "source_stage", "sourceStage", sourceName),
    ...readMappedOptionalString(input, "output", "output", sourceName)
  }));
}

function readOutputs(value: unknown, stageId: string, sourceName: string): WorkflowOutput[] {
  return readRecordArray(value, `outputs for stage ${stageId}`, sourceName).map((output) => ({
    id: readString(output, "id", sourceName),
    path: readString(output, "path", sourceName),
    required: readBoolean(output, "required", sourceName),
    ...readMappedOptionalString(output, "schema", "schema", sourceName)
  }));
}

function readCompletionCriteria(value: unknown, stageId: string, sourceName: string): CompletionCriterion[] {
  return readRecordArray(value, `completion_criteria for stage ${stageId}`, sourceName).map((criterion) => ({
    type: readString(criterion, "type", sourceName),
    ...readMappedOptionalString(criterion, "output", "output", sourceName),
    ...readMappedOptionalString(criterion, "schema", "schema", sourceName)
  }));
}

function readRepairPolicy(value: unknown, stageId: string, sourceName: string): RepairPolicy {
  if (!isRecord(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "repair_policy for stage ${stageId}" must be an object.`);
  }

  return {
    allowRepair: readBoolean(value, "allow_repair", sourceName),
    maxAttempts: readNumber(value, "max_attempts", sourceName),
    writesAllowed: readBoolean(value, "writes_allowed", sourceName)
  };
}

function readRerunTriggers(value: unknown, stageId: string, sourceName: string): RerunTrigger[] {
  return readRecordArray(value, `rerun_when for stage ${stageId}`, sourceName).map((trigger) => ({
    type: readString(trigger, "type", sourceName),
    paths: readStringArray(trigger.paths ?? [], `paths for rerun trigger in stage ${stageId}`, sourceName),
    artifacts: readStringArray(
      trigger.artifacts ?? [],
      `artifacts for rerun trigger in stage ${stageId}`,
      sourceName
    )
  }));
}

function assertUniqueStageIds(stages: WorkflowStage[], sourceName: string) {
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.id)) {
      throw new AgentMatrixError(`Workflow ${sourceName} defines duplicate stage id "${stage.id}".`);
    }
    seen.add(stage.id);
  }
}

function assertKnownDependencies(stages: WorkflowStage[], sourceName: string) {
  const stageIds = new Set(stages.map((stage) => stage.id));
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (!stageIds.has(dependency)) {
        throw new AgentMatrixError(
          `Workflow ${sourceName} stage "${stage.id}" depends on unknown stage "${dependency}".`
        );
      }
    }
  }
}

function readString(record: Record<string, unknown>, key: string, sourceName: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${key}" must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, sourceName: string) {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${key}" must be a string.`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string, sourceName: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${key}" must be an integer.`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string, sourceName: string) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${key}" must be a boolean.`);
  }
  return value;
}

function readStringArray(value: unknown, fieldName: string, sourceName: string) {
  if (!Array.isArray(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldName}" must be a string array.`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new AgentMatrixError(
        `Workflow ${sourceName} field "${fieldName}" item ${index + 1} must be a non-empty string.`
      );
    }
    return item;
  });
}

function readRecordArray(value: unknown, fieldName: string, sourceName: string) {
  if (!Array.isArray(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldName}" must be an object array.`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new AgentMatrixError(
        `Workflow ${sourceName} field "${fieldName}" item ${index + 1} must be an object.`
      );
    }
    return item;
  });
}

function readMappedOptionalString(
  record: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
  sourceName: string
) {
  const value = readOptionalString(record, sourceKey, sourceName);
  return value === undefined ? {} : { [targetKey]: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
