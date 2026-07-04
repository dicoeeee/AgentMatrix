import { parse } from "yaml";

import { AgentMatrixError } from "./errors.js";
import type { WorkflowDefinition, WorkflowStage } from "./types.js";

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
  const agentRole = readString(stageValue, "agent_role", sourceName);
  const verifierRole = readString(stageValue, "verifier_role", sourceName);

  return {
    id,
    name,
    dependsOn,
    agentRole,
    verifierRole
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
