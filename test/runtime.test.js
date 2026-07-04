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

function stageReport(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "placeholder",
    stage_id: "placeholder",
    status: "success",
    summary: "Fixture stage report.",
    commands: [],
    findings: [],
    artifacts: [],
    skipped: [],
    changed_files: [],
    ...overrides
  };
}

function reportingRuntimeAdapter(report) {
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
        ...report,
        run_id: context.runState.id,
        stage_id: context.stage.id
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
        accepted: true,
        checked_artifact: context.stageReportPath
      });

      return {
        accepted: true,
        evidencePath: context.verifierEvidencePath
      };
    }
  };
}

async function createRejectedRun(report, expectedMessage) {
  const cwd = await tempProject();
  await initializeProject(cwd);

  await assert.rejects(
    () => createRun(cwd, "mr-preflight", { runtimeAdapter: reportingRuntimeAdapter(report) }),
    expectedMessage
  );

  return readRuns(cwd);
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
  assert.equal(runState.stages[0].failure.kind, "verifier_failure");
});

test("runtime fails a stage when the stage report violates the built-in schema", async () => {
  const invalidReport = stageReport();
  delete invalidReport.commands;

  const [runState] = await createRejectedRun(invalidReport, /stage_report.*commands/);

  assert.equal(runState.status, "failed");
  assert.equal(runState.stages[0].status, "failed");
  assert.equal(runState.stages[0].failure.kind, "schema_failure");
  assert.match(runState.stages[0].failure.message, /commands/);
  assert.equal(runState.stages[1].status, "pending");
});

test("runtime fails a stage when commands_ok sees a failed command", async () => {
  const [runState] = await createRejectedRun(
    stageReport({
      commands: [{ command: "npm test", status: "failed", exit_code: 1 }]
    }),
    /command failed/
  );

  assert.equal(runState.status, "failed");
  assert.equal(runState.stages[0].status, "failed");
  assert.equal(runState.stages[0].failure.kind, "command_failure");
  assert.deepEqual(runState.stages[0].failure.metadata, {
    command: "npm test",
    exitCode: 1
  });
});

for (const [blockerType, failureKind] of [
  ["missing_resource", "missing_resource"],
  ["human_required", "human_required_blocker"],
  ["external_required", "external_required_blocker"]
]) {
  test(`runtime records ${failureKind} metadata from blockers`, async () => {
    const [runState] = await createRejectedRun(
      stageReport({
        blockers: [{ type: blockerType, message: `${blockerType} fixture` }]
      }),
      /blocker/
    );

    assert.equal(runState.status, "failed");
    assert.equal(runState.stages[0].status, "failed");
    assert.equal(runState.stages[0].failure.kind, failureKind);
    assert.deepEqual(runState.stages[0].failure.metadata, {
      blockerType,
      blockerMessage: `${blockerType} fixture`
    });
  });
}

test("runtime rejects skipped stage reports without a skip reason", async () => {
  const [runState] = await createRejectedRun(
    stageReport({
      status: "skipped",
      skipped: []
    }),
    /skip reason/
  );

  assert.equal(runState.status, "failed");
  assert.equal(runState.stages[0].status, "failed");
  assert.equal(runState.stages[0].failure.kind, "schema_failure");
});
