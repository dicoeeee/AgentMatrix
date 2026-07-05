import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRun, initializeProject, readRuns, resumeRun } from "../dist/storage.js";

import { createMockRuntimeAdapter } from "../dist/mock-runtime.js";

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

async function readJson(projectRoot, relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

async function writeText(projectRoot, relativePath, data) {
  const filePath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
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

function nodeGate(id, source, overrides = {}) {
  return {
    id,
    name: id,
    command: `node -e ${id}`,
    argv: [process.execPath, "-e", source],
    mode: "read-only",
    kind: "lint",
    ...overrides
  };
}

function nodeTestCommand(id, source, overrides = {}) {
  return {
    id,
    name: id,
    command: `node -e ${id}`,
    argv: [process.execPath, "-e", source],
    ...overrides
  };
}

function parallelBarrierScript(barrierDir, readyFile, peerFile) {
  return `
const fs = require("node:fs");
const path = require("node:path");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const dir = ${JSON.stringify(barrierDir)};
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "${readyFile}"), "ready\\n");
  const peerPath = path.join(dir, "${peerFile}");
  const startedAt = Date.now();
  while (!fs.existsSync(peerPath)) {
    if (Date.now() - startedAt > 1500) {
      process.exit(23);
    }
    await wait(20);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

function serializedIncrementScript(fileName) {
  return `
const fs = require("node:fs");
const path = require("node:path");
const filePath = path.join(process.cwd(), "${fileName}");
const before = Number(fs.readFileSync(filePath, "utf8"));
setTimeout(() => {
  fs.writeFileSync(filePath, String(before + 1) + "\\n");
}, 100);
`;
}

function recordRunScript(logPath) {
  return `require("node:fs").appendFileSync(${JSON.stringify(logPath)}, "run\\n");`;
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

test("static_check aggregates read-only gates in parallel and records language references", async () => {
  const cwd = await tempProject();
  const barrierDir = path.join(tmpdir(), `agentmatrix-static-check-barrier-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await initializeProject(cwd);
  await writeText(cwd, "package.json", JSON.stringify({ scripts: {} }, null, 2) + "\n");
  await writeText(cwd, "src/index.ts", "export const value: number = 1;\n");
  await writeText(cwd, "src/index.js", "export const value = 1;\n");
  await writeText(cwd, "native/main.c", "int main(void) { return 0; }\n");
  await writeText(cwd, "native/main.cpp", "int main() { return 0; }\n");
  await writeText(cwd, "java/Main.java", "class Main {}\n");
  await writeText(cwd, "go.mod", "module example.com/agentmatrix\n");
  await writeText(cwd, "Cargo.toml", "[package]\nname = \"agentmatrix-fixture\"\nversion = \"0.1.0\"\n");
  await writeText(cwd, "script.py", "print('ok')\n");
  await writeText(cwd, "scripts/check.sh", "#!/bin/sh\nexit 0\n");

  const runState = await createRun(cwd, "mr-preflight", {
    runtimeAdapter: createMockRuntimeAdapter({
      staticCheck: {
        gates: [
          nodeGate("lint", parallelBarrierScript(barrierDir, "lint.ready", "typecheck.ready"), {
            name: "Lint",
            kind: "lint"
          }),
          nodeGate("typecheck", parallelBarrierScript(barrierDir, "typecheck.ready", "lint.ready"), {
            name: "Typecheck",
            kind: "typecheck"
          }),
          nodeGate("security", "", {
            name: "Security Scan",
            kind: "security"
          }),
          nodeGate("dependency", "", {
            name: "Dependency Scan",
            kind: "dependency"
          })
        ]
      }
    })
  });

  const stageReportPath = path.join(runState.artifactPath, "static_check", "stage-report.json");
  const report = await readJson(cwd, stageReportPath);
  assert.equal(report.status, "success");
  assert.deepEqual(
    report.commands.map((command) => [command.name, command.status, command.parallel_group]),
    [
      ["Lint", "success", "read-only-1"],
      ["Typecheck", "success", "read-only-1"],
      ["Security Scan", "success", "read-only-1"],
      ["Dependency Scan", "success", "read-only-1"]
    ]
  );
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.changed_files, []);

  const referencesPath = path.join(runState.artifactPath, "static_check", "language-references.json");
  assert.ok(report.artifacts.includes(referencesPath));
  const references = await readJson(cwd, referencesPath);
  assert.deepEqual(
    references.languages.map((language) => [language.id, language.reference]),
    [
      ["c", "static-check/references/c.md"],
      ["cpp", "static-check/references/cpp.md"],
      ["java", "static-check/references/java.md"],
      ["go", "static-check/references/go.md"],
      ["rust", "static-check/references/rust.md"],
      ["javascript", "static-check/references/javascript.md"],
      ["typescript", "static-check/references/typescript.md"],
      ["python", "static-check/references/python.md"],
      ["shell", "static-check/references/shell.md"]
    ]
  );
});

test("static_check isolates read-only gates from workspace writes", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);

  const runState = await createRun(cwd, "mr-preflight", {
    runtimeAdapter: createMockRuntimeAdapter({
      staticCheck: {
        gates: [
          nodeGate(
            "mutating-read-only",
            'require("node:fs").writeFileSync("unexpected-write.txt", "mutation\\n");',
            {
              name: "Mutating Read-only Gate",
              kind: "lint"
            }
          )
        ]
      }
    })
  });

  await assert.rejects(() => readFile(path.join(cwd, "unexpected-write.txt"), "utf8"), { code: "ENOENT" });

  assert.equal(runState.status, "success");

  const report = await readJson(cwd, path.join(runState.artifactPath, "static_check", "stage-report.json"));
  assert.deepEqual(
    report.commands.map((command) => [command.name, command.status]),
    [["Mutating Read-only Gate", "success"]]
  );
  assert.deepEqual(report.changed_files, []);
});

test("static_check serializes writer gates and reports changed files", async () => {
  const cwd = await tempProject();
  const readOnlyLogPath = path.join(tmpdir(), `agentmatrix-static-check-rerun-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  await initializeProject(cwd);
  await writeText(cwd, "static-check-counter.txt", "0\n");

  const runState = await createRun(cwd, "mr-preflight", {
    runtimeAdapter: createMockRuntimeAdapter({
      staticCheck: {
        gates: [
          nodeGate("lint", recordRunScript(readOnlyLogPath), {
            name: "Lint",
            kind: "lint"
          }),
          nodeGate("autofix-a", serializedIncrementScript("static-check-counter.txt"), {
            name: "Autofix A",
            kind: "formatter",
            mode: "writer"
          }),
          nodeGate("autofix-b", serializedIncrementScript("static-check-counter.txt"), {
            name: "Autofix B",
            kind: "formatter",
            mode: "writer"
          })
        ]
      }
    })
  });

  assert.equal((await readFile(path.join(cwd, "static-check-counter.txt"), "utf8")).trim(), "2");

  const stageReportPath = path.join(runState.artifactPath, "static_check", "stage-report.json");
  const report = await readJson(cwd, stageReportPath);
  assert.deepEqual(
    report.commands.map((command) => [command.name, command.status, command.parallel_group ?? null]),
    [
      ["Lint", "success", null],
      ["Autofix A", "success", null],
      ["Autofix B", "success", null],
      ["Lint", "success", null]
    ]
  );
  assert.equal((await readFile(readOnlyLogPath, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(report.changed_files, ["static-check-counter.txt"]);
});

test("test_check discovers and runs repository test commands", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);
  await writeText(
    cwd,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          test: "node test-pass.js"
        }
      },
      null,
      2
    ) + "\n"
  );
  await writeText(cwd, "test-pass.js", "console.log('package tests passed');\n");

  const runState = await createRun(cwd, "mr-preflight", { runtimeAdapter: createMockRuntimeAdapter() });
  const report = await readJson(cwd, path.join(runState.artifactPath, "test_check", "stage-report.json"));

  assert.equal(report.status, "success");
  assert.deepEqual(
    report.commands.map((command) => [command.name, command.command, command.status, command.exit_code]),
    [["Test", "npm run test", "success", 0]]
  );
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.changed_files, []);

  const outputPath = path.join(runState.artifactPath, "test_check", "test-output.json");
  assert.ok(report.artifacts.includes(outputPath));
  const output = await readJson(cwd, outputPath);
  assert.match(output.commands[0].stdout, /package tests passed/);
});

test("test_check runs configured test commands", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);

  const runState = await createRun(cwd, "mr-preflight", {
    runtimeAdapter: createMockRuntimeAdapter({
      testCheck: {
        commands: [
          nodeTestCommand("configured-tests", "console.log('configured tests passed');", {
            name: "Configured Tests"
          })
        ]
      }
    })
  });
  const report = await readJson(cwd, path.join(runState.artifactPath, "test_check", "stage-report.json"));

  assert.equal(report.status, "success");
  assert.deepEqual(
    report.commands.map((command) => [command.name, command.command, command.status, command.exit_code]),
    [["Configured Tests", "node -e configured-tests", "success", 0]]
  );
});

test("test_check fails with command metadata and findings when tests fail", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);
  await writeText(
    cwd,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          test: "node test-fail.js"
        }
      },
      null,
      2
    ) + "\n"
  );
  await writeText(cwd, "test-fail.js", "console.error('expected failure detail'); process.exit(7);\n");

  await assert.rejects(
    () => createRun(cwd, "mr-preflight", { runtimeAdapter: createMockRuntimeAdapter() }),
    /Stage "test_check" command failed: npm run test/
  );

  const [runState] = await readRuns(cwd);
  assert.equal(runState.status, "failed");
  assert.equal(runState.stages[1].status, "failed");
  assert.equal(runState.stages[1].failure.kind, "command_failure");
  assert.deepEqual(runState.stages[1].failure.metadata, {
    command: "npm run test",
    exitCode: 7
  });

  const report = await readJson(cwd, path.join(runState.artifactPath, "test_check", "stage-report.json"));
  assert.equal(report.status, "failed");
  assert.deepEqual(report.commands.map((command) => [command.name, command.status, command.exit_code]), [
    ["Test", "failed", 7]
  ]);
  assert.deepEqual(report.findings, [
    {
      severity: "blocker",
      source: "test",
      message: "expected failure detail"
    }
  ]);
});

test("test_check blocks expectation-updating test commands", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);
  await writeText(
    cwd,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          test: "node -e \"require('node:fs').writeFileSync('should-not-run.txt', 'updated')\" -- --updateSnapshot"
        }
      },
      null,
      2
    ) + "\n"
  );

  await assert.rejects(
    () => createRun(cwd, "mr-preflight", { runtimeAdapter: createMockRuntimeAdapter() }),
    /reported blocker/
  );
  await assert.rejects(() => readFile(path.join(cwd, "should-not-run.txt"), "utf8"), { code: "ENOENT" });

  const [runState] = await readRuns(cwd);
  assert.equal(runState.stages[1].failure.kind, "human_required_blocker");
  const report = await readJson(cwd, path.join(runState.artifactPath, "test_check", "stage-report.json"));
  assert.deepEqual(report.commands, [
    {
      name: "Test",
      command: "npm run test",
      status: "skipped",
      reason: "Command appears to update snapshots, generated expectations, or test assertions."
    }
  ]);
  assert.deepEqual(report.blockers, [
    {
      type: "human_required",
      message: "Refusing to run expectation-updating test command: npm run test."
    }
  ]);
});

test("test_check blocks configured update flags and Makefile update recipes", async () => {
  const configured = await tempProject();
  await initializeProject(configured);

  await assert.rejects(
    () =>
      createRun(configured, "mr-preflight", {
        runtimeAdapter: createMockRuntimeAdapter({
          testCheck: {
            commands: [
              nodeTestCommand("configured-update", "console.log('should not run');", {
                name: "Configured Update",
                command: "npm test",
                argv: [process.execPath, "-e", "console.log('should not run')", "--updateSnapshot"]
              })
            ]
          }
        })
      }),
    /reported blocker/
  );
  const [configuredRun] = await readRuns(configured);
  const configuredReport = await readJson(
    configured,
    path.join(configuredRun.artifactPath, "test_check", "stage-report.json")
  );
  assert.deepEqual(configuredReport.commands, [
    {
      name: "Configured Update",
      command: "npm test",
      status: "skipped",
      reason: "Command appears to update snapshots, generated expectations, or test assertions."
    }
  ]);

  const makeProject = await tempProject();
  await initializeProject(makeProject);
  await writeText(makeProject, "Makefile", "test:\n\tjest -u\n");

  await assert.rejects(
    () => createRun(makeProject, "mr-preflight", { runtimeAdapter: createMockRuntimeAdapter() }),
    /reported blocker/
  );
  const [makeRun] = await readRuns(makeProject);
  const makeReport = await readJson(makeProject, path.join(makeRun.artifactPath, "test_check", "stage-report.json"));
  assert.deepEqual(makeReport.blockers, [
    {
      type: "human_required",
      message: "Refusing to run expectation-updating test command: make test."
    }
  ]);
});

test("test_check fails when a safe-looking test mutates expectations", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);
  await writeText(
    cwd,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          test: "node test-mutates.js"
        }
      },
      null,
      2
    ) + "\n"
  );
  await writeText(cwd, "snapshot.txt", "old\n");
  await writeText(cwd, "test-mutates.js", "require('node:fs').writeFileSync('snapshot.txt', 'new\\n');\n");

  await assert.rejects(
    () => createRun(cwd, "mr-preflight", { runtimeAdapter: createMockRuntimeAdapter() }),
    /Stage "test_check" command failed: npm run test/
  );

  assert.equal(await readFile(path.join(cwd, "snapshot.txt"), "utf8"), "old\n");

  const [runState] = await readRuns(cwd);
  const report = await readJson(cwd, path.join(runState.artifactPath, "test_check", "stage-report.json"));
  assert.equal(report.commands[0].status, "failed");
  assert.match(report.commands[0].summary, /changed files in isolated workspace: snapshot\.txt/);
  assert.deepEqual(report.changed_files, []);
});

test("test_check permits benign isolated test artifacts", async () => {
  const cwd = await tempProject();
  await initializeProject(cwd);
  await writeText(
    cwd,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          test: "node test-writes-temp.js"
        }
      },
      null,
      2
    ) + "\n"
  );
  await writeText(
    cwd,
    "test-writes-temp.js",
    "require('node:fs').mkdirSync('tmp', { recursive: true }); require('node:fs').writeFileSync('tmp/output.txt', 'ok\\n');\n"
  );

  const runState = await createRun(cwd, "mr-preflight", { runtimeAdapter: createMockRuntimeAdapter() });

  assert.equal(runState.status, "success");
  await assert.rejects(() => readFile(path.join(cwd, "tmp", "output.txt"), "utf8"), { code: "ENOENT" });

  const report = await readJson(cwd, path.join(runState.artifactPath, "test_check", "stage-report.json"));
  assert.equal(report.commands[0].status, "success");
  assert.deepEqual(report.changed_files, []);
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
