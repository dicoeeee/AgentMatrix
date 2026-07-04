export const DEFAULT_WORKFLOW_ID = "mr-preflight";
export const DEFAULT_WORKFLOW_FILE = "mr-preflight.workflow.yml";

export const DEFAULT_WORKFLOW_YAML = `schema_version: 1
id: mr-preflight
name: MR Preflight
description: Structured preflight workflow for MR-ready output.
stages:
  - id: static_check
    name: Static Check
    depends_on: []
    agent_role: static_check
    verifier_role: static_check_verifier
  - id: test_check
    name: Test Check
    depends_on:
      - static_check
    agent_role: test_check
    verifier_role: test_check_verifier
  - id: code_review
    name: Code Review
    depends_on:
      - test_check
    agent_role: code_review
    verifier_role: code_review_verifier
  - id: mr_prepare
    name: MR Prepare
    depends_on:
      - code_review
    agent_role: mr_prepare
    verifier_role: mr_prepare_verifier
`;
