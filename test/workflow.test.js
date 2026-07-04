import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_WORKFLOW_YAML } from "../dist/templates.js";
import { parseWorkflow } from "../dist/workflow.js";

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
    { type: "no_blockers" }
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
  assert.deepEqual(staticCheck.skills, ["static-check"]);
  assert.equal(Object.hasOwn(staticCheck, "command"), false);
});
