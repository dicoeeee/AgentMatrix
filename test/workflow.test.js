import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_WORKFLOW_YAML } from "../dist/templates.js";
import { parseWorkflow } from "../dist/workflow.js";

const VALID_WORKFLOW = `schema_version: 1
id: fixture
name: Fixture
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
    mcp_resources:
      - filesystem
    agent_role: static_check
    verifier_role: static_check_verifier
    skills:
      - static-check
`;

function assertWorkflowError(source, pattern) {
  assert.throws(() => parseWorkflow(source, "fixture.workflow.yml"), pattern);
}

test("parseWorkflow reads the editable mr-preflight stage contract", () => {
  const workflow = parseWorkflow(DEFAULT_WORKFLOW_YAML, "mr-preflight.workflow.yml");

  assert.equal(workflow.id, "mr-preflight");
  assert.deepEqual(
    workflow.stages.map((stage) => stage.id),
    ["static_check", "test_check", "code_review", "mr_prepare"]
  );

  const staticCheck = workflow.stages[0];
  assert.deepEqual(staticCheck.inputs, [{ id: "workspace", required: true }]);
  assert.deepEqual(staticCheck.outputs, [
    { id: "stage_report", path: "static_check/stage-report.json", required: true, schema: "stage_report" }
  ]);
  assert.deepEqual(staticCheck.completionCriteria, [
    { type: "output_exists", output: "stage_report" },
    { type: "schema_valid", output: "stage_report", schema: "stage_report" },
    { type: "commands_ok" },
    { type: "no_blockers" },
    { type: "skip_reason_present" }
  ]);
  assert.deepEqual(staticCheck.repairPolicy, {
    allowRepair: true,
    maxAttempts: 1,
    writesAllowed: true
  });
  assert.deepEqual(staticCheck.rerunWhen, [
    { type: "changed_files", paths: ["**/*"], artifacts: [] },
    { type: "changed_artifacts", paths: [], artifacts: ["static_check/stage-report.json"] }
  ]);
  assert.deepEqual(staticCheck.mcpResources, []);
  assert.deepEqual(staticCheck.skills, ["static-check"]);
  assert.equal(Object.hasOwn(staticCheck, "command"), false);
});

test("parseWorkflow rejects malformed YAML with the workflow location", () => {
  assert.throws(
    () => parseWorkflow("schema_version: [", "broken.workflow.yml"),
    /Invalid workflow YAML in broken\.workflow\.yml/
  );
});

test("parseWorkflow rejects missing required stage fields with field paths", () => {
  assertWorkflowError(
    VALID_WORKFLOW.replace("    agent_role: static_check\n", ""),
    /fixture\.workflow\.yml.*stages\[0\]\.agent_role/
  );
});

test("parseWorkflow rejects missing stage inputs and outputs", () => {
  assertWorkflowError(
    VALID_WORKFLOW.replace(/    inputs:\n      - id: workspace\n        required: true\n/, ""),
    /fixture\.workflow\.yml.*stages\[0\]\.inputs/
  );
  assertWorkflowError(
    VALID_WORKFLOW.replace(
      /    outputs:\n      - id: stage_report\n        path: static_check\/stage-report\.json\n        required: true\n        schema: stage_report\n/,
      ""
    ),
    /fixture\.workflow\.yml.*stages\[0\]\.outputs/
  );
});

test("parseWorkflow rejects invalid completion criteria", () => {
  assertWorkflowError(
    VALID_WORKFLOW.replace("      - type: output_exists", "      - type: conversation_accepts"),
    /fixture\.workflow\.yml.*stages\[0\]\.completion_criteria\[0\]\.type/
  );
  assertWorkflowError(
    VALID_WORKFLOW.replace("        output: stage_report", "        output: missing_report"),
    /fixture\.workflow\.yml.*stages\[0\]\.completion_criteria\[0\]\.output/
  );
  assertWorkflowError(
    VALID_WORKFLOW.replace("      - type: commands_ok", "      - type: commands_ok\n        output: stage_report"),
    /fixture\.workflow\.yml.*stages\[0\]\.completion_criteria\[2\]\.output/
  );
});

test("parseWorkflow rejects workflow stage status fields", () => {
  assertWorkflowError(
    VALID_WORKFLOW.replace("    name: Static Check\n", "    name: Static Check\n    status: done\n"),
    /fixture\.workflow\.yml.*stages\[0\]\.status/
  );
});

test("parseWorkflow accepts logical roles and rejects platform-specific role paths", () => {
  const workflow = parseWorkflow(VALID_WORKFLOW, "fixture.workflow.yml");
  assert.equal(workflow.stages[0].agentRole, "static_check");
  assert.equal(workflow.stages[0].verifierRole, "static_check_verifier");
  assert.deepEqual(workflow.stages[0].mcpResources, ["filesystem"]);

  assertWorkflowError(
    VALID_WORKFLOW.replace("    agent_role: static_check", "    agent_role: opencode/static_check"),
    /fixture\.workflow\.yml.*stages\[0\]\.agent_role.*logical agent role/
  );
});

test("parseWorkflow rejects stages without the required stage_report output", () => {
  assertWorkflowError(
    VALID_WORKFLOW.replace("      - id: stage_report", "      - id: custom_report"),
    /fixture\.workflow\.yml.*stages\[0\]\.outputs.*stage_report/
  );
});

test("parseWorkflow reports field paths for duplicate and unknown dependencies", () => {
  const duplicateStage = VALID_WORKFLOW.replace(
    "stages:",
    `stages:
  - id: static_check
    name: Duplicate
    depends_on: []
    inputs:
      - id: workspace
        required: true
    outputs:
      - id: stage_report
        path: duplicate/stage-report.json
        required: true
        schema: stage_report
    completion_criteria:
      - type: output_exists
        output: stage_report
    repair_policy:
      allow_repair: false
      max_attempts: 0
      writes_allowed: false
    rerun_when: []
    agent_role: static_check
    verifier_role: static_check_verifier
    skills: []`
  );

  assertWorkflowError(duplicateStage, /fixture\.workflow\.yml.*stages\[1\]\.id/);
  assertWorkflowError(
    VALID_WORKFLOW.replace("    depends_on: []", "    depends_on:\n      - missing_stage"),
    /fixture\.workflow\.yml.*stages\[0\]\.depends_on\[0\]/
  );
});
