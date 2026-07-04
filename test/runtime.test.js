import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRun, initializeProject, readRuns, resumeRun } from "../dist/storage.js";

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

async function writeRunState(projectRoot, runState) {
  await writeJson(projectRoot, path.join(".agentmatrix", "runs", runState.id, "run.json"), runState);
}

async function writeDeclaredOutputs(context) {
  for (const output of context.stage.outputs) {
    const outputPath = path.join(context.runState.artifactPath, output.path);
    if (outputPath !== context.stageReportPath) {
      await writeFile(path.join(context.projectRoot, outputPath), `Fixture output for ${output.id}\n`);
    }
  }
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
      await writeDeclaredOutputs(context);

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

function stagedReportingRuntimeAdapter(reportForStage) {
  const executionCounts = new Map();

  return {
    async executeStage(context) {
      const count = executionCounts.get(context.stage.id) ?? 0;
      executionCounts.set(context.stage.id, count + 1);
      const report = stageReport(reportForStage(context.stage.id, count));

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
      await writeDeclaredOutputs(context);

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

function noChangeRuntimeAdapter() {
  return stagedReportingRuntimeAdapter(() => ({}));
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

async function createCompletedRun(runtimeAdapter = noChangeRuntimeAdapter()) {
  const cwd = await tempProject();
  await initializeProject(cwd);
  const runState = await createRun(cwd, "mr-preflight", { runtimeAdapter });
  return { cwd, runState };
}

async function markStageFailed(projectRoot, runState, stageId) {
  const nextRunState = structuredClone(runState);
  nextRunState.status = "failed";
  const stage = nextRunState.stages.find((candidate) => candidate.id === stageId);
  assert.ok(stage, `Expected ${stageId} to exist`);
  stage.status = "failed";
  stage.failure = {
    kind: "command_failure",
    message: `Fixture failure in ${stageId}.`
  };
  await writeRunState(projectRoot, nextRunState);
  return nextRunState;
}

function startedAfter(runState, eventCount) {
  return runState.events.slice(eventCount).filter((event) => event.type === "stage_started").map((event) => event.stageId);
}

function assertAllStagesSuccessful(runState) {
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status]),
    [
      ["static_check", "success"],
      ["test_check", "success"],
      ["code_review", "success"],
      ["mr_prepare", "success"]
    ]
  );
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

test("runtime keeps successful stages when a repair report records no changes", async () => {
  const { cwd, runState } = await createCompletedRun();
  const originalEventCount = runState.events.length;
  const originalCodeReviewEvidence = runState.stages.find((stage) => stage.id === "code_review").evidence;
  await markStageFailed(cwd, runState, "test_check");

  const resumed = await resumeRun(cwd, runState.id, { runtimeAdapter: noChangeRuntimeAdapter() });

  assert.equal(resumed.status, "success");
  assert.deepEqual(startedAfter(resumed, originalEventCount), ["test_check"]);
  assertAllStagesSuccessful(resumed);
  assert.deepEqual(resumed.stages.find((stage) => stage.id === "code_review").evidence, originalCodeReviewEvidence);
});

test("runtime reruns stale stages after a repair report records changed code", async () => {
  const { cwd, runState } = await createCompletedRun();
  const originalEventCount = runState.events.length;
  await markStageFailed(cwd, runState, "test_check");

  const resumed = await resumeRun(cwd, runState.id, {
    runtimeAdapter: stagedReportingRuntimeAdapter((stageId, count) =>
      stageId === "test_check" && count === 0 ? { changed_files: ["src/fixed.ts"] } : {}
    )
  });

  assert.equal(resumed.status, "success");
  assert.deepEqual(startedAfter(resumed, originalEventCount), [
    "test_check",
    "static_check",
    "test_check",
    "code_review",
    "mr_prepare"
  ]);
  assertAllStagesSuccessful(resumed);
});

test("runtime reruns stale stages after a repair report records changed artifacts", async () => {
  const { cwd, runState } = await createCompletedRun();
  const originalEventCount = runState.events.length;
  await markStageFailed(cwd, runState, "static_check");

  const resumed = await resumeRun(cwd, runState.id, {
    runtimeAdapter: stagedReportingRuntimeAdapter((stageId, count) =>
      stageId === "static_check" && count === 0
        ? { changed_artifacts: ["static_check/stage-report.json"] }
        : {}
    )
  });

  assert.equal(resumed.status, "success");
  assert.deepEqual(startedAfter(resumed, originalEventCount), [
    "static_check",
    "test_check",
    "code_review",
    "mr_prepare"
  ]);
  assertAllStagesSuccessful(resumed);
});

test("runtime leaves successful stages alone when rerun triggers do not match repair changes", async () => {
  const { cwd, runState } = await createCompletedRun();
  const originalEventCount = runState.events.length;
  const staleRunState = await markStageFailed(cwd, runState, "test_check");
  for (const stage of staleRunState.stages) {
    stage.rerunWhen = [{ type: "changed_files", paths: ["docs/**"], artifacts: [] }];
  }
  await writeRunState(cwd, staleRunState);

  const resumed = await resumeRun(cwd, runState.id, {
    runtimeAdapter: stagedReportingRuntimeAdapter((stageId, count) =>
      stageId === "test_check" && count === 0 ? { changed_files: ["src/fixed.ts"] } : {}
    )
  });

  assert.equal(resumed.status, "success");
  assert.deepEqual(startedAfter(resumed, originalEventCount), ["test_check"]);
  assertAllStagesSuccessful(resumed);
});
