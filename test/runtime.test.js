import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRun, initializeProject, readRuns } from "../dist/storage.js";

async function tempProject() {
  const root = path.join(tmpdir(), `agentmatrix-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function writeJson(projectRoot, relativePath, data) {
  const filePath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

function rejectingRuntimeAdapter() {
  return {
    async executeStage(context) {
      await writeJson(context.projectRoot, context.executorEvidencePath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        agent_role: context.stage.agentRole,
        status: "success"
      });
      await writeJson(context.projectRoot, context.stageReportPath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        status: "success",
        summary: `Executor completed ${context.stage.id}.`,
        commands: [],
        findings: [],
        artifacts: [context.executorEvidencePath],
        skipped: [],
        changed_files: []
      });

      return {
        stageReportPath: context.stageReportPath,
        evidencePath: context.executorEvidencePath
      };
    },
    async verifyStage(context) {
      await writeJson(context.projectRoot, context.verifierEvidencePath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        verifier_role: context.stage.verifierRole,
        accepted: false,
        checked_artifact: context.stageReportPath
      });

      return {
        accepted: false,
        evidencePath: context.verifierEvidencePath
      };
    }
  };
}

test("runtime stops before the next stage when verifier rejects evidence", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);

  await assert.rejects(
    () => createRun(cwd, "mr-preflight", { runtimeAdapter: rejectingRuntimeAdapter() }),
    /Verifier static_check_verifier rejected stage "static_check"/
  );

  const [runState] = await readRuns(cwd);
  assert.equal(runState.status, "failed");
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status]),
    [
      ["static_check", "failed"],
      ["test_check", "pending"],
      ["code_review", "pending"],
      ["mr_prepare", "pending"]
    ]
  );
  assert.deepEqual(
    runState.events.map((event) => [event.type, event.stageId ?? null]),
    [
      ["run_created", null],
      ["run_started", null],
      ["stage_started", "static_check"],
      ["stage_executor_completed", "static_check"],
      ["stage_verified", "static_check"]
    ]
  );
});
