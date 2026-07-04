import { Ajv, type ErrorObject } from "ajv";
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
import {
  BUILT_IN_SCHEMAS,
  COMPLETION_CRITERION_TYPES,
  type CompletionCriterionType,
  LOGICAL_ROLE_PATTERN,
  RERUN_TRIGGER_TYPES,
  type RerunTriggerType
} from "./workflow-constants.js";
import { WORKFLOW_SCHEMA } from "./workflow-schema.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateWorkflowSchema = ajv.compile(WORKFLOW_SCHEMA);

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

  validateWorkflowDocument(document, sourceName);
  const schemaVersion = readNumber(document, "schema_version", sourceName, "schema_version");
  const id = readString(document, "id", sourceName, "id");
  const name = readString(document, "name", sourceName, "name");
  const description = readOptionalString(document, "description", sourceName, "description");
  const stagesValue = document.stages;

  if (!Array.isArray(stagesValue) || stagesValue.length === 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "stages" must define at least one stage.`);
  }

  const stages = stagesValue.map((stageValue, index) => parseWorkflowStage(stageValue, index, sourceName));
  assertUniqueStageIds(stages, sourceName);
  assertKnownDependencies(stages, sourceName);
  assertKnownInputDependencies(stages, sourceName);

  return {
    schemaVersion,
    id,
    name,
    ...(description ? { description } : {}),
    stages
  };
}

function validateWorkflowDocument(document: Record<string, unknown>, sourceName: string) {
  if (validateWorkflowSchema(document)) {
    return;
  }

  const error = validateWorkflowSchema.errors?.[0];
  if (!error) {
    throw new AgentMatrixError(`Workflow ${sourceName} failed JSON Schema validation.`);
  }

  throw new AgentMatrixError(formatSchemaError(sourceName, error));
}

function formatSchemaError(sourceName: string, error: ErrorObject) {
  const fieldPath = schemaErrorPath(error);

  if (error.keyword === "required") {
    return `Workflow ${sourceName} field "${fieldPath}" is required.`;
  }

  if (error.keyword === "additionalProperties") {
    const propertyName = String(error.params.additionalProperty);
    if (propertyName === "status") {
      return `Workflow ${sourceName} field "${fieldPath}" is not supported; stage status belongs to run state.`;
    }
    return `Workflow ${sourceName} field "${fieldPath}" is not supported.`;
  }

  if (error.keyword === "enum") {
    return `Workflow ${sourceName} field "${fieldPath}" must be one of: ${allowedValues(error).join(", ")}.`;
  }

  if (error.keyword === "minItems") {
    return `Workflow ${sourceName} field "${fieldPath}" must contain at least one item.`;
  }

  return `Workflow ${sourceName} field "${fieldPath}" ${error.message ?? "is invalid"}.`;
}

function schemaErrorPath(error: ErrorObject) {
  const basePath = jsonPointerToFieldPath(error.instancePath);

  if (error.keyword === "required") {
    return joinFieldPath(basePath, String(error.params.missingProperty));
  }

  if (error.keyword === "additionalProperties") {
    return joinFieldPath(basePath, String(error.params.additionalProperty));
  }

  return basePath || "workflow";
}

function jsonPointerToFieldPath(pointer: string) {
  const segments = pointer.split("/").filter(Boolean).map((segment) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~")
  );

  return segments.reduce((path, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${path}[${segment}]`;
    }
    return joinFieldPath(path, segment);
  }, "");
}

function joinFieldPath(basePath: string, segment: string) {
  return basePath ? `${basePath}.${segment}` : segment;
}

function allowedValues(error: ErrorObject) {
  const allowed = error.schema;
  return Array.isArray(allowed) ? allowed.map(String) : [];
}

function parseWorkflowStage(stageValue: unknown, index: number, sourceName: string): WorkflowStage {
  if (!isRecord(stageValue)) {
    throw new AgentMatrixError(`Stage ${index + 1} in ${sourceName} must be a YAML object.`);
  }

  const stagePath = `stages[${index}]`;

  const id = readString(stageValue, "id", sourceName, `${stagePath}.id`);
  const name = readOptionalString(stageValue, "name", sourceName, `${stagePath}.name`) ?? id;
  const dependsOn = readStringArray(stageValue.depends_on, `${stagePath}.depends_on`, sourceName);
  const inputs = readInputs(stageValue.inputs, stagePath, sourceName);
  const outputs = readOutputs(stageValue.outputs, stagePath, sourceName);
  assertStageReportOutput(outputs, stagePath, sourceName);
  const completionCriteria = readCompletionCriteria(stageValue.completion_criteria, stagePath, sourceName);
  assertCompletionCriteria(completionCriteria, outputs, stagePath, sourceName);
  const repairPolicy = readRepairPolicy(stageValue.repair_policy, stagePath, sourceName);
  const rerunWhen = readRerunTriggers(stageValue.rerun_when, stagePath, sourceName);
  const agentRole = readRole(stageValue, "agent_role", sourceName, `${stagePath}.agent_role`);
  const verifierRole = readRole(stageValue, "verifier_role", sourceName, `${stagePath}.verifier_role`);
  const skills = readStringArray(stageValue.skills, `${stagePath}.skills`, sourceName);

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

function readInputs(value: unknown, stagePath: string, sourceName: string): WorkflowInput[] {
  return readRecordArray(value, `${stagePath}.inputs`, sourceName, { requireNonEmpty: true }).map((input, index) => {
    const inputPath = `${stagePath}.inputs[${index}]`;

    return {
      id: readString(input, "id", sourceName, `${inputPath}.id`),
      required: readBoolean(input, "required", sourceName, `${inputPath}.required`),
      ...readMappedOptionalString(input, "source_stage", "sourceStage", sourceName, `${inputPath}.source_stage`),
      ...readMappedOptionalString(input, "output", "output", sourceName, `${inputPath}.output`)
    };
  });
}

function readOutputs(value: unknown, stagePath: string, sourceName: string): WorkflowOutput[] {
  return readRecordArray(value, `${stagePath}.outputs`, sourceName, { requireNonEmpty: true }).map((output, index) => {
    const outputPath = `${stagePath}.outputs[${index}]`;
    const schema = readOptionalSchemaId(output, "schema", sourceName, `${outputPath}.schema`);

    return {
      id: readString(output, "id", sourceName, `${outputPath}.id`),
      path: readString(output, "path", sourceName, `${outputPath}.path`),
      required: readBoolean(output, "required", sourceName, `${outputPath}.required`),
      ...(schema ? { schema } : {})
    };
  });
}

function readCompletionCriteria(value: unknown, stagePath: string, sourceName: string): CompletionCriterion[] {
  return readRecordArray(value, `${stagePath}.completion_criteria`, sourceName, { requireNonEmpty: true }).map(
    (criterion, index) => {
      const criterionPath = `${stagePath}.completion_criteria[${index}]`;
      const schema = readOptionalSchemaId(criterion, "schema", sourceName, `${criterionPath}.schema`);

      return {
        type: readCompletionCriterionType(criterion, sourceName, `${criterionPath}.type`),
        ...readMappedOptionalString(criterion, "output", "output", sourceName, `${criterionPath}.output`),
        ...(schema ? { schema } : {})
      };
    }
  );
}

function readRepairPolicy(value: unknown, stagePath: string, sourceName: string): RepairPolicy {
  if (!isRecord(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${stagePath}.repair_policy" must be an object.`);
  }

  return {
    allowRepair: readBoolean(value, "allow_repair", sourceName, `${stagePath}.repair_policy.allow_repair`),
    maxAttempts: readNonNegativeInteger(value, "max_attempts", sourceName, `${stagePath}.repair_policy.max_attempts`),
    writesAllowed: readBoolean(value, "writes_allowed", sourceName, `${stagePath}.repair_policy.writes_allowed`)
  };
}

function readRerunTriggers(value: unknown, stagePath: string, sourceName: string): RerunTrigger[] {
  return readRecordArray(value, `${stagePath}.rerun_when`, sourceName).map((trigger, index) => {
    const triggerPath = `${stagePath}.rerun_when[${index}]`;

    const rerunTrigger = {
      type: readRerunTriggerType(trigger, sourceName, `${triggerPath}.type`),
      paths: readStringArray(trigger.paths ?? [], `${triggerPath}.paths`, sourceName),
      artifacts: readStringArray(trigger.artifacts ?? [], `${triggerPath}.artifacts`, sourceName)
    };

    assertRerunTrigger(rerunTrigger, triggerPath, sourceName);
    return rerunTrigger;
  });
}

function assertUniqueStageIds(stages: WorkflowStage[], sourceName: string) {
  const seen = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    if (seen.has(stage.id)) {
      throw new AgentMatrixError(
        `Workflow ${sourceName} field "stages[${index}].id" defines duplicate stage id "${stage.id}".`
      );
    }
    seen.add(stage.id);
  }
}

function assertKnownDependencies(stages: WorkflowStage[], sourceName: string) {
  const stageIds = new Set(stages.map((stage) => stage.id));
  for (const [stageIndex, stage] of stages.entries()) {
    for (const [dependencyIndex, dependency] of stage.dependsOn.entries()) {
      if (!stageIds.has(dependency)) {
        throw new AgentMatrixError(
          `Workflow ${sourceName} field "stages[${stageIndex}].depends_on[${dependencyIndex}]" references unknown stage "${dependency}".`
        );
      }
    }
  }
}

function assertStageReportOutput(outputs: WorkflowOutput[], stagePath: string, sourceName: string) {
  const stageReport = outputs.find((output) => output.id === "stage_report");
  if (!stageReport) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${stagePath}.outputs" must include stage_report.`);
  }

  if (!stageReport.required) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${stagePath}.outputs.stage_report.required" must be true.`);
  }

  if (stageReport.schema !== "stage_report") {
    throw new AgentMatrixError(
      `Workflow ${sourceName} field "${stagePath}.outputs.stage_report.schema" must be stage_report.`
    );
  }
}

function assertKnownInputDependencies(stages: WorkflowStage[], sourceName: string) {
  const outputIdsByStage = new Map(stages.map((stage) => [stage.id, new Set(stage.outputs.map((output) => output.id))]));

  for (const [stageIndex, stage] of stages.entries()) {
    for (const [inputIndex, input] of stage.inputs.entries()) {
      if (!input.sourceStage) {
        continue;
      }

      const sourceOutputs = outputIdsByStage.get(input.sourceStage);
      const inputPath = `stages[${stageIndex}].inputs[${inputIndex}]`;
      if (!sourceOutputs) {
        throw new AgentMatrixError(
          `Workflow ${sourceName} field "${inputPath}.source_stage" references unknown stage "${input.sourceStage}".`
        );
      }
      if (!input.output) {
        throw new AgentMatrixError(
          `Workflow ${sourceName} field "${inputPath}.output" is required when source_stage is set.`
        );
      }
      if (!sourceOutputs.has(input.output)) {
        throw new AgentMatrixError(
          `Workflow ${sourceName} field "${inputPath}.output" references unknown output "${input.output}" on stage "${input.sourceStage}".`
        );
      }
    }
  }
}

function assertCompletionCriteria(
  criteria: CompletionCriterion[],
  outputs: WorkflowOutput[],
  stagePath: string,
  sourceName: string
) {
  const outputIds = new Set(outputs.map((output) => output.id));

  criteria.forEach((criterion, index) => {
    const criterionPath = `${stagePath}.completion_criteria[${index}]`;
    if (criterion.type === "output_exists" || criterion.type === "schema_valid") {
      if (!criterion.output) {
        throw new AgentMatrixError(`Workflow ${sourceName} field "${criterionPath}.output" is required.`);
      }
      if (!outputIds.has(criterion.output)) {
        throw new AgentMatrixError(
          `Workflow ${sourceName} field "${criterionPath}.output" references unknown output "${criterion.output}".`
        );
      }
    }

    if (criterion.type === "schema_valid" && !criterion.schema) {
      throw new AgentMatrixError(`Workflow ${sourceName} field "${criterionPath}.schema" is required.`);
    }

    if (criterion.type === "output_exists" && criterion.schema) {
      throw new AgentMatrixError(`Workflow ${sourceName} field "${criterionPath}.schema" is not supported.`);
    }

    if (criterion.type !== "output_exists" && criterion.type !== "schema_valid") {
      if (criterion.output) {
        throw new AgentMatrixError(`Workflow ${sourceName} field "${criterionPath}.output" is not supported.`);
      }
      if (criterion.schema) {
        throw new AgentMatrixError(`Workflow ${sourceName} field "${criterionPath}.schema" is not supported.`);
      }
    }
  });
}

function assertRerunTrigger(trigger: RerunTrigger, triggerPath: string, sourceName: string) {
  if (trigger.type === "changed_files" && trigger.paths.length === 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${triggerPath}.paths" must contain at least one path.`);
  }

  if (trigger.type === "changed_artifacts" && trigger.artifacts.length === 0) {
    throw new AgentMatrixError(
      `Workflow ${sourceName} field "${triggerPath}.artifacts" must contain at least one artifact.`
    );
  }
}

function readString(record: Record<string, unknown>, key: string, sourceName: string, fieldPath: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldPath}" must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, sourceName: string, fieldPath: string) {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldPath}" must be a string.`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string, sourceName: string, fieldPath: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldPath}" must be an integer.`);
  }
  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string, sourceName: string, fieldPath: string) {
  const value = readNumber(record, key, sourceName, fieldPath);
  if (value < 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldPath}" must be greater than or equal to 0.`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string, sourceName: string, fieldPath: string) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldPath}" must be a boolean.`);
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

function readRecordArray(
  value: unknown,
  fieldName: string,
  sourceName: string,
  options: { requireNonEmpty?: boolean } = {}
) {
  if (!Array.isArray(value)) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldName}" must be an object array.`);
  }
  if (options.requireNonEmpty && value.length === 0) {
    throw new AgentMatrixError(`Workflow ${sourceName} field "${fieldName}" must contain at least one item.`);
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
  sourceName: string,
  fieldPath: string
) {
  const value = readOptionalString(record, sourceKey, sourceName, fieldPath);
  return value === undefined ? {} : { [targetKey]: value };
}

function readCompletionCriterionType(
  record: Record<string, unknown>,
  sourceName: string,
  fieldPath: string
): CompletionCriterionType {
  const value = readString(record, "type", sourceName, fieldPath);
  if (!COMPLETION_CRITERION_TYPES.includes(value as CompletionCriterionType)) {
    throw new AgentMatrixError(
      `Workflow ${sourceName} field "${fieldPath}" must be one of: ${COMPLETION_CRITERION_TYPES.join(", ")}.`
    );
  }
  return value as CompletionCriterionType;
}

function readRerunTriggerType(
  record: Record<string, unknown>,
  sourceName: string,
  fieldPath: string
): RerunTriggerType {
  const value = readString(record, "type", sourceName, fieldPath);
  if (!RERUN_TRIGGER_TYPES.includes(value as RerunTriggerType)) {
    throw new AgentMatrixError(
      `Workflow ${sourceName} field "${fieldPath}" must be one of: ${RERUN_TRIGGER_TYPES.join(", ")}.`
    );
  }
  return value as RerunTriggerType;
}

function readOptionalSchemaId(
  record: Record<string, unknown>,
  key: string,
  sourceName: string,
  fieldPath: string
) {
  const value = readOptionalString(record, key, sourceName, fieldPath);
  if (value !== undefined && !BUILT_IN_SCHEMAS.includes(value as typeof BUILT_IN_SCHEMAS[number])) {
    throw new AgentMatrixError(
      `Workflow ${sourceName} field "${fieldPath}" must reference a built-in schema: ${BUILT_IN_SCHEMAS.join(", ")}.`
    );
  }
  return value;
}

function readRole(record: Record<string, unknown>, key: string, sourceName: string, fieldPath: string) {
  const value = readString(record, key, sourceName, fieldPath);
  if (!LOGICAL_ROLE_PATTERN.test(value)) {
    throw new AgentMatrixError(
      `Workflow ${sourceName} field "${fieldPath}" must be a logical agent role id, not a platform-specific path.`
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
