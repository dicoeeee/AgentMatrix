export const COMPLETION_CRITERION_TYPES = [
  "output_exists",
  "schema_valid",
  "commands_ok",
  "no_blockers",
  "skip_reason_present"
] as const;

export type CompletionCriterionType = typeof COMPLETION_CRITERION_TYPES[number];

export const RERUN_TRIGGER_TYPES = ["changed_files", "changed_artifacts"] as const;

export type RerunTriggerType = typeof RERUN_TRIGGER_TYPES[number];

export const BUILT_IN_SCHEMAS = ["stage_report"] as const;

export const LOGICAL_ROLE_PATTERN = /^[a-z][a-z0-9_]*$/;
