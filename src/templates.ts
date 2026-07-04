export const DEFAULT_WORKFLOW_ID = "mr-preflight";
export const DEFAULT_WORKFLOW_FILE = "mr-preflight.workflow.yml";
export const BUILT_IN_WORKFLOW_IDS = [DEFAULT_WORKFLOW_ID] as const;
export type BuiltInWorkflowId = typeof BUILT_IN_WORKFLOW_IDS[number];

export function isBuiltInWorkflowId(workflowId: string): workflowId is BuiltInWorkflowId {
  return BUILT_IN_WORKFLOW_IDS.includes(workflowId as BuiltInWorkflowId);
}

export const DEFAULT_WORKFLOW_YAML = `schema_version: 1
id: mr-preflight
name: MR Preflight
description: Structured preflight workflow for MR-ready output.
stages:
  - id: static_check
    name: Static Check
    depends_on: []
    inputs:
      - id: workspace
        required: true
    outputs:
      - id: stage_report
        path: static_check/stage-report.json
        required: true
        schema: stage_report
    completion_criteria:
      - type: output_exists
        output: stage_report
      - type: schema_valid
        output: stage_report
        schema: stage_report
      - type: commands_ok
      - type: no_blockers
    repair_policy:
      allow_repair: true
      max_attempts: 1
      writes_allowed: true
    rerun_when:
      - type: changed_files
        paths:
          - "**/*"
      - type: changed_artifacts
        artifacts:
          - static_check/stage-report.json
    agent_role: static_check
    verifier_role: static_check_verifier
    skills:
      - static-check
  - id: test_check
    name: Test Check
    depends_on:
      - static_check
    inputs:
      - id: workspace
        required: true
      - id: static_check_report
        source_stage: static_check
        output: stage_report
        required: true
    outputs:
      - id: stage_report
        path: test_check/stage-report.json
        required: true
        schema: stage_report
    completion_criteria:
      - type: output_exists
        output: stage_report
      - type: schema_valid
        output: stage_report
        schema: stage_report
      - type: commands_ok
      - type: no_blockers
    repair_policy:
      allow_repair: false
      max_attempts: 0
      writes_allowed: false
    rerun_when:
      - type: changed_files
        paths:
          - "**/*"
      - type: changed_artifacts
        artifacts:
          - static_check/stage-report.json
          - test_check/stage-report.json
    agent_role: test_check
    verifier_role: test_check_verifier
    skills: []
  - id: code_review
    name: Code Review
    depends_on:
      - test_check
    inputs:
      - id: static_check_report
        source_stage: static_check
        output: stage_report
        required: true
      - id: test_check_report
        source_stage: test_check
        output: stage_report
        required: true
    outputs:
      - id: stage_report
        path: code_review/stage-report.json
        required: true
        schema: stage_report
    completion_criteria:
      - type: output_exists
        output: stage_report
      - type: schema_valid
        output: stage_report
        schema: stage_report
      - type: no_blockers
    repair_policy:
      allow_repair: false
      max_attempts: 0
      writes_allowed: false
    rerun_when:
      - type: changed_files
        paths:
          - "**/*"
      - type: changed_artifacts
        artifacts:
          - static_check/stage-report.json
          - test_check/stage-report.json
          - code_review/stage-report.json
    agent_role: code_review
    verifier_role: code_review_verifier
    skills:
      - industry-code-review
  - id: mr_prepare
    name: MR Prepare
    depends_on:
      - code_review
    inputs:
      - id: static_check_report
        source_stage: static_check
        output: stage_report
        required: true
      - id: test_check_report
        source_stage: test_check
        output: stage_report
        required: true
      - id: code_review_report
        source_stage: code_review
        output: stage_report
        required: true
    outputs:
      - id: stage_report
        path: mr_prepare/stage-report.json
        required: true
        schema: stage_report
      - id: mr_title
        path: mr_prepare/title.md
        required: true
      - id: mr_description
        path: mr_prepare/description.md
        required: true
    completion_criteria:
      - type: output_exists
        output: stage_report
      - type: output_exists
        output: mr_title
      - type: output_exists
        output: mr_description
      - type: schema_valid
        output: stage_report
        schema: stage_report
      - type: no_blockers
    repair_policy:
      allow_repair: false
      max_attempts: 0
      writes_allowed: false
    rerun_when:
      - type: changed_artifacts
        artifacts:
          - static_check/stage-report.json
          - test_check/stage-report.json
          - code_review/stage-report.json
          - mr_prepare/stage-report.json
          - mr_prepare/title.md
          - mr_prepare/description.md
    agent_role: mr_prepare
    verifier_role: mr_prepare_verifier
    skills: []
`;
