import { Ajv, type AnySchema, type ErrorObject } from "ajv";

import { AgentMatrixError } from "./errors.js";

export type StageReportStatus = "success" | "failed" | "skipped";
export type StageCommandStatus = "success" | "failed" | "skipped";
export type StageBlockerType = "missing_resource" | "human_required" | "external_required";

export interface StageReportCommand {
  command: string;
  status: StageCommandStatus;
  exit_code?: number;
  summary?: string;
}

export interface StageReportBlocker {
  type: StageBlockerType;
  message: string;
  resource?: string;
}

export interface StageReportSkippedItem {
  id?: string;
  reason: string;
}

export interface StageReport {
  schema_version: 1;
  run_id: string;
  stage_id: string;
  status: StageReportStatus;
  summary: string;
  commands: StageReportCommand[];
  findings: Record<string, unknown>[];
  artifacts: string[];
  skipped: StageReportSkippedItem[];
  changed_files: string[];
  changed_artifacts?: string[];
  blockers?: StageReportBlocker[];
  skip_reason?: string;
}

const STAGE_REPORT_SCHEMA: AnySchema = {
  type: "object",
  required: [
    "schema_version",
    "run_id",
    "stage_id",
    "status",
    "summary",
    "commands",
    "findings",
    "artifacts",
    "skipped",
    "changed_files"
  ],
  additionalProperties: false,
  properties: {
    schema_version: {
      const: 1
    },
    run_id: {
      type: "string",
      minLength: 1
    },
    stage_id: {
      type: "string",
      minLength: 1
    },
    status: {
      type: "string",
      enum: ["success", "failed", "skipped"]
    },
    summary: {
      type: "string"
    },
    commands: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "status"],
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            minLength: 1
          },
          status: {
            type: "string",
            enum: ["success", "failed", "skipped"]
          },
          exit_code: {
            type: "integer"
          },
          summary: {
            type: "string"
          }
        }
      }
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    artifacts: {
      type: "array",
      items: {
        type: "string",
        minLength: 1
      }
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        required: ["reason"],
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            minLength: 1
          },
          reason: {
            type: "string",
            minLength: 1
          }
        }
      }
    },
    changed_files: {
      type: "array",
      items: {
        type: "string",
        minLength: 1
      }
    },
    changed_artifacts: {
      type: "array",
      items: {
        type: "string",
        minLength: 1
      }
    },
    blockers: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "message"],
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["missing_resource", "human_required", "external_required"]
          },
          message: {
            type: "string",
            minLength: 1
          },
          resource: {
            type: "string",
            minLength: 1
          }
        }
      }
    },
    skip_reason: {
      type: "string",
      minLength: 1
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateStageReportSchema = ajv.compile(STAGE_REPORT_SCHEMA);

export function parseStageReport(source: string, label: string): StageReport {
  let document: unknown;

  try {
    document = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentMatrixError(`Stage report ${label} is not valid JSON for stage_report schema: ${detail}`);
  }

  if (validateStageReportSchema(document)) {
    return document as StageReport;
  }

  const error = validateStageReportSchema.errors?.[0];
  if (!error) {
    throw new AgentMatrixError(`Stage report ${label} failed stage_report schema validation.`);
  }

  throw new AgentMatrixError(formatStageReportSchemaError(label, error));
}

export function failedCommand(report: StageReport): StageReportCommand | undefined {
  return report.commands.find(
    (command) => command.status === "failed" || (command.exit_code !== undefined && command.exit_code !== 0)
  );
}

export function firstBlocker(report: StageReport): StageReportBlocker | undefined {
  return report.blockers?.[0];
}

export function hasSkipReason(report: StageReport) {
  return Boolean(report.skip_reason?.trim()) || report.skipped.some((item) => item.reason.trim().length > 0);
}

function formatStageReportSchemaError(label: string, error: ErrorObject) {
  const fieldPath = schemaErrorPath(error);

  if (error.keyword === "required") {
    return `Stage report ${label} failed stage_report schema: field "${fieldPath}" is required.`;
  }

  if (error.keyword === "additionalProperties") {
    const propertyName = String(error.params.additionalProperty);
    return `Stage report ${label} failed stage_report schema: field "${joinFieldPath(
      fieldPath,
      propertyName
    )}" is not supported.`;
  }

  if (error.keyword === "enum") {
    return `Stage report ${label} failed stage_report schema: field "${fieldPath}" must be one of: ${allowedValues(
      error
    ).join(", ")}.`;
  }

  return `Stage report ${label} failed stage_report schema: field "${fieldPath}" ${error.message ?? "is invalid"}.`;
}

function schemaErrorPath(error: ErrorObject) {
  const basePath = jsonPointerToFieldPath(error.instancePath);

  if (error.keyword === "required") {
    return joinFieldPath(basePath, String(error.params.missingProperty));
  }

  return basePath || "stage_report";
}

function jsonPointerToFieldPath(pointer: string) {
  const segments = pointer.split("/").filter(Boolean).map((segment) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~")
  );

  return segments.reduce((fieldPath, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${fieldPath}[${segment}]`;
    }
    return joinFieldPath(fieldPath, segment);
  }, "");
}

function joinFieldPath(basePath: string, segment: string) {
  return basePath ? `${basePath}.${segment}` : segment;
}

function allowedValues(error: ErrorObject) {
  const allowed = error.schema;
  return Array.isArray(allowed) ? allowed.map(String) : [];
}
