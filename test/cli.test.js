import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

async function tempProject() {
  const root = path.join(tmpdir(), `agentmatrix-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function runCli(args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

function parseRunId(stdout) {
  const match = stdout.match(/Created run ([^\s]+)/);
  assert.ok(match, `Expected stdout to contain a run id, got:\n${stdout}`);
  return match[1];
}

async function readRunState(cwd, runId) {
  return JSON.parse(await readFile(path.join(cwd, ".agentmatrix", "runs", runId, "run.json"), "utf8"));
}

async function writeRunState(cwd, runState) {
  await writeFile(
    path.join(cwd, ".agentmatrix", "runs", runState.id, "run.json"),
    JSON.stringify(runState, null, 2) + "\n"
  );
}

async function readProjectJson(cwd, relativePath) {
  return JSON.parse(await readFile(path.join(cwd, relativePath), "utf8"));
}

async function createCompletedRun(cwd) {
  assert.equal((await runCli(["init"], cwd)).code, 0);
  const run = await runCli(["run"], cwd);
  assert.equal(run.code, 0, run.stderr);
  return parseRunId(run.stdout);
}

async function makeInterruptedAfterStaticCheck(cwd, runId) {
  const runState = await readRunState(cwd, runId);
  runState.status = "running";
  runState.stages = runState.stages.map((stage) => {
    if (stage.id === "static_check") {
      return stage;
    }

    return {
      ...stage,
      status: stage.id === "test_check" ? "running" : "pending",
      evidence: [],
      artifacts: []
    };
  });
  runState.events = runState.events.slice(0, 5);
  await writeRunState(cwd, runState);
}

async function makeFailedAtTestCheck(cwd, runId) {
  const runState = await readRunState(cwd, runId);
  runState.status = "failed";
  runState.stages = runState.stages.map((stage) => {
    if (stage.id === "static_check") {
      return stage;
    }
    if (stage.id === "test_check") {
      return {
        ...stage,
        status: "failed",
        failure: {
          kind: "command_failure",
          message: 'Stage "test_check" command failed: npm test.',
          metadata: {
            command: "npm test",
            exitCode: 1
          }
        }
      };
    }
    return {
      ...stage,
      status: "pending",
      evidence: [],
      artifacts: []
    };
  });
  runState.events = runState.events.slice(0, 8);
  await writeRunState(cwd, runState);
}

test("help output lists the supported MVP verbs", async () => {
  const cwd = await tempProject();
  const result = await runCli(["--help"], cwd);

  assert.equal(result.code, 0, result.stderr);
  for (const command of ["init", "run", "resume", "status", "visualize"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }

  const runHelp = await runCli(["run", "--help"], cwd);
  assert.equal(runHelp.code, 0, runHelp.stderr);
  assert.match(runHelp.stdout, /agentmatrix run/);
  assert.match(runHelp.stdout, /fresh workflow run/);
});

test("init creates a project-local runtime skeleton without requiring git", async () => {
  const cwd = await tempProject();
  const result = await runCli(["init"], cwd);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Initialized AgentMatrix/);
  assert.equal(await exists(path.join(cwd, ".git")), false);
  assert.equal(await exists(path.join(cwd, ".agentmatrix", "runs")), true);
  assert.equal(await exists(path.join(cwd, ".agentmatrix", "artifacts")), true);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  assert.equal(await exists(workflowPath), true);
  assert.match(await readFile(workflowPath, "utf8"), /id: mr-preflight/);
});

test("init can choose the built-in mr-preflight workflow template", async () => {
  const cwd = await tempProject();
  const result = await runCli(["init", "--workflow", "mr-preflight"], cwd);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /mr-preflight\.workflow\.yml/);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  assert.match(await readFile(workflowPath, "utf8"), /id: mr-preflight/);

  const unsupported = await runCli(["init", "--workflow", "unknown"], await tempProject());
  assert.equal(unsupported.code, 2);
  assert.match(unsupported.stderr, /Unknown workflow template/);
});

test("init copies an editable mr-preflight workflow with complete stage contracts", async () => {
  const cwd = await tempProject();
  const result = await runCli(["init"], cwd);

  assert.equal(result.code, 0, result.stderr);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const workflow = parse(await readFile(workflowPath, "utf8"));

  assert.equal(workflow.id, "mr-preflight");
  assert.deepEqual(
    workflow.stages.map((stage) => stage.id),
    ["static_check", "test_check", "code_review", "mr_prepare"]
  );
  assert.deepEqual(
    workflow.stages.map((stage) => stage.depends_on),
    [[], ["static_check"], ["test_check"], ["code_review"]]
  );

  for (const stage of workflow.stages) {
    assert.ok(Array.isArray(stage.inputs), `${stage.id} should declare inputs`);
    assert.ok(Array.isArray(stage.outputs), `${stage.id} should declare outputs`);
    assert.ok(Array.isArray(stage.completion_criteria), `${stage.id} should declare completion criteria`);
    assert.ok(stage.repair_policy, `${stage.id} should declare repair policy`);
    assert.ok(Array.isArray(stage.rerun_when), `${stage.id} should declare rerun triggers`);
    assert.ok(Array.isArray(stage.mcp_resources), `${stage.id} should declare MCP resources`);
    assert.equal(typeof stage.agent_role, "string");
    assert.equal(typeof stage.verifier_role, "string");
    assert.ok(Array.isArray(stage.skills), `${stage.id} should declare platform-visible skills`);
    assert.equal(Object.hasOwn(stage, "command"), false, `${stage.id} should not define a command abstraction`);
  }

  const skillNames = workflow.stages.flatMap((stage) => stage.skills);
  assert.ok(skillNames.includes("static-check"));
  assert.ok(skillNames.includes("industry-code-review"));

  const config = JSON.parse(await readFile(path.join(cwd, ".agentmatrix", "config.json"), "utf8"));
  assert.ok(config.availableResources.agents.includes("static_check"));
  assert.ok(config.availableResources.agents.includes("static_check_verifier"));
  assert.ok(config.availableResources.skills.includes("static-check"));
  assert.deepEqual(config.availableResources.mcpResources, []);
});

test("run always creates a fresh completed filesystem-backed run", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const first = await runCli(["run"], cwd);
  const second = await runCli(["run"], cwd);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const firstRunId = parseRunId(first.stdout);
  const secondRunId = parseRunId(second.stdout);
  assert.notEqual(firstRunId, secondRunId);
  assert.match(first.stdout, new RegExp(`\\.agentmatrix/runs/${firstRunId}/run\\.json`));

  const runIds = await readdir(path.join(cwd, ".agentmatrix", "runs"));
  assert.equal(runIds.length, 2);

  const runState = await readRunState(cwd, firstRunId);
  assert.equal(runState.workflowId, "mr-preflight");
  assert.equal(runState.status, "success");
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status]),
    [
      ["static_check", "success"],
      ["test_check", "success"],
      ["code_review", "success"],
      ["mr_prepare", "success"]
    ]
  );
});

test("run executes mr-preflight stages with mock executor and verifier evidence", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const run = await runCli(["run"], cwd);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Completed run/);

  const runId = parseRunId(run.stdout);
  const runState = await readRunState(cwd, runId);
  assert.equal(runState.status, "success");
  assert.deepEqual(
    runState.events.map((event) => [event.type, event.stageId ?? null]),
    [
      ["run_created", null],
      ["run_started", null],
      ["stage_started", "static_check"],
      ["stage_executor_completed", "static_check"],
      ["stage_verified", "static_check"],
      ["stage_started", "test_check"],
      ["stage_executor_completed", "test_check"],
      ["stage_verified", "test_check"],
      ["stage_started", "code_review"],
      ["stage_executor_completed", "code_review"],
      ["stage_verified", "code_review"],
      ["stage_started", "mr_prepare"],
      ["stage_executor_completed", "mr_prepare"],
      ["stage_verified", "mr_prepare"],
      ["run_completed", null]
    ]
  );

  for (const stage of runState.stages) {
    const expectedArtifacts = stage.id === "mr_prepare" ? 3 : 1;
    assert.equal(stage.status, "success");
    assert.equal(stage.artifacts.length, expectedArtifacts);
    assert.equal(stage.evidence.length, 2);

    const stageReport = await readProjectJson(cwd, stage.artifacts[0]);
    assert.equal(stageReport.stage_id, stage.id);
    assert.equal(stageReport.status, "success");
    assert.equal(stageReport.summary, `Mock executor completed ${stage.id}.`);
    assert.deepEqual(stageReport.skipped, []);
    assert.deepEqual(stageReport.changed_files, []);
    assert.deepEqual(stageReport.blockers, []);

    const executorEvidence = await readProjectJson(cwd, stage.evidence[0]);
    assert.equal(executorEvidence.stage_id, stage.id);
    assert.equal(executorEvidence.agent_role, stage.agentRole);
    assert.equal(executorEvidence.status, "success");

    const verifierEvidence = await readProjectJson(cwd, stage.evidence[1]);
    assert.equal(verifierEvidence.stage_id, stage.id);
    assert.equal(verifierEvidence.verifier_role, stage.verifierRole);
    assert.equal(verifierEvidence.accepted, true);
    assert.equal(verifierEvidence.checked_artifact, stage.artifacts[0]);
  }
});

test("run validates edited workflow before creating a run", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  await writeFile(
    workflowPath,
    `schema_version: 1
id: mr-preflight
name: Broken
stages:
  - id: static_check
    depends_on: []
    inputs:
      - id: workspace
        required: true
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
    skills: []
`
  );

  const result = await runCli(["run"], cwd);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mr-preflight\.workflow\.yml/);
  assert.match(result.stderr, /stages\[0\]\.outputs/);
  assert.deepEqual(await readdir(path.join(cwd, ".agentmatrix", "runs")), []);
});

test("run checks required resources before creating a run", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const configPath = path.join(cwd, ".agentmatrix", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.availableResources = {
    agents: [
      "test_check",
      "test_check_verifier",
      "code_review",
      "code_review_verifier",
      "mr_prepare",
      "mr_prepare_verifier"
    ],
    skills: ["industry-code-review"],
    mcpResources: []
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace(
      "    mcp_resources: []\n    agent_role: static_check",
      "    mcp_resources:\n      - github\n    agent_role: static_check"
    )
  );

  const result = await runCli(["run"], cwd);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing required resources/);
  assert.match(result.stderr, /agent: static_check/);
  assert.match(result.stderr, /skill: static-check/);
  assert.match(result.stderr, /mcp_resource: github/);
  assert.match(result.stderr, /installer/);
  assert.deepEqual(await readdir(path.join(cwd, ".agentmatrix", "runs")), []);
});

test("resume validates the edited workflow before continuing a run", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  await makeInterruptedAfterStaticCheck(cwd, runId);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const validWorkflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, validWorkflow.replace("      - type: output_exists", "      - type: conversation_accepts"));

  const result = await runCli(["resume", runId], cwd);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mr-preflight\.workflow\.yml/);
  assert.match(result.stderr, /completion_criteria\[0\]\.type/);
});

test("resume checks required resources before mutating run state", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  await makeInterruptedAfterStaticCheck(cwd, runId);
  const runPath = path.join(cwd, ".agentmatrix", "runs", runId, "run.json");
  const before = JSON.parse(await readFile(runPath, "utf8"));

  const configPath = path.join(cwd, ".agentmatrix", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.availableResources = {
    agents: before.stages
      .flatMap((stage) => [stage.agentRole, stage.verifierRole])
      .filter((role) => role !== "static_check_verifier"),
    skills: before.stages.flatMap((stage) => stage.skills),
    mcpResources: before.stages.flatMap((stage) => stage.mcpResources)
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  const result = await runCli(["resume", runId], cwd);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing required resources/);
  assert.match(result.stderr, /agent: static_check_verifier/);

  const after = JSON.parse(await readFile(runPath, "utf8"));
  assert.deepEqual(after.events, before.events);
});

test("resume continues an interrupted run from the first incomplete stage", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  await makeInterruptedAfterStaticCheck(cwd, runId);

  const resume = await runCli(["resume", runId], cwd);
  assert.equal(resume.code, 0, resume.stderr);
  assert.match(resume.stdout, new RegExp(`Resumed run ${runId}`));
  assert.match(resume.stdout, new RegExp(`Completed run ${runId}`));
  assert.equal((await readdir(path.join(cwd, ".agentmatrix", "runs"))).length, 1);

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.status, "success");
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status]),
    [
      ["static_check", "success"],
      ["test_check", "success"],
      ["code_review", "success"],
      ["mr_prepare", "success"]
    ]
  );
  assert.deepEqual(
    runState.events
      .filter((event) => event.type === "stage_started")
      .map((event) => event.stageId),
    ["static_check", "test_check", "code_review", "mr_prepare"]
  );
  assert.equal(runState.events.filter((event) => event.type === "run_created").length, 1);
  assert.equal(runState.events.some((event) => event.type === "resume_requested"), true);
});

test("resume retries a failed run from the failed stage", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  await makeFailedAtTestCheck(cwd, runId);

  const resume = await runCli(["resume", runId], cwd);
  assert.equal(resume.code, 0, resume.stderr);
  assert.match(resume.stdout, new RegExp(`Resumed run ${runId}`));
  assert.equal((await readdir(path.join(cwd, ".agentmatrix", "runs"))).length, 1);

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.status, "success");
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status, stage.failure?.kind ?? null]),
    [
      ["static_check", "success", null],
      ["test_check", "success", null],
      ["code_review", "success", null],
      ["mr_prepare", "success", null]
    ]
  );
  assert.deepEqual(
    runState.events
      .filter((event) => event.type === "stage_started")
      .map((event) => event.stageId),
    ["static_check", "test_check", "test_check", "code_review", "mr_prepare"]
  );
});

test("visualize validates the edited workflow before rendering run state", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);
  const runId = parseRunId((await runCli(["run"], cwd)).stdout);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const validWorkflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, validWorkflow.replace("    verifier_role: static_check_verifier", "    verifier_role: opencode/static_check_verifier"));

  const result = await runCli(["visualize", runId], cwd);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mr-preflight\.workflow\.yml/);
  assert.match(result.stderr, /stages\[0\]\.verifier_role/);
});

test("run validation reports malformed YAML and unsupported workflow status from temporary projects", async () => {
  const malformed = await tempProject();
  assert.equal((await runCli(["init"], malformed)).code, 0);
  const malformedWorkflowPath = path.join(malformed, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  await writeFile(malformedWorkflowPath, "schema_version: [");

  const malformedResult = await runCli(["run"], malformed);
  assert.equal(malformedResult.code, 1);
  assert.match(malformedResult.stderr, /Invalid workflow YAML/);
  assert.match(malformedResult.stderr, /mr-preflight\.workflow\.yml/);

  const unsupportedStatus = await tempProject();
  assert.equal((await runCli(["init"], unsupportedStatus)).code, 0);
  const statusWorkflowPath = path.join(unsupportedStatus, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const validWorkflow = await readFile(statusWorkflowPath, "utf8");
  await writeFile(statusWorkflowPath, validWorkflow.replace("    name: Static Check", "    name: Static Check\n    status: done"));

  const statusResult = await runCli(["run"], unsupportedStatus);
  assert.equal(statusResult.code, 1);
  assert.match(statusResult.stderr, /stages\[0\]\.status/);
});

test("resume, status, and visualize expose run state", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);

  const status = await runCli(["status"], cwd);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(runId));
  assert.match(status.stdout, /success/);
  assert.match(status.stdout, /static_check=success/);
  assert.match(status.stdout, /mr_prepare=success/);

  const resume = await runCli(["resume", runId], cwd);
  assert.equal(resume.code, 1);
  assert.match(resume.stderr, /not resumable/);

  const mermaid = await runCli(["visualize", runId], cwd);
  assert.equal(mermaid.code, 0, mermaid.stderr);
  assert.match(mermaid.stdout, /graph TD/);
  assert.match(mermaid.stdout, /static_check/);
  assert.match(mermaid.stdout, /mr_prepare/);

  const json = await runCli(["visualize", runId, "--format", "json"], cwd);
  assert.equal(json.code, 0, json.stderr);
  const graph = JSON.parse(json.stdout);
  assert.equal(graph.runId, runId);
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.status]),
    [
      ["static_check", "success"],
      ["test_check", "success"],
      ["code_review", "success"],
      ["mr_prepare", "success"]
    ]
  );
  assert.deepEqual(graph.edges, [
    { from: "static_check", to: "test_check" },
    { from: "test_check", to: "code_review" },
    { from: "code_review", to: "mr_prepare" }
  ]);
});

test("status summarizes failed and skipped stages with failure metadata", async () => {
  const cwd = await tempProject();
  const completedRunId = await createCompletedRun(cwd);
  const failedRunId = parseRunId((await runCli(["run"], cwd)).stdout);
  await makeFailedAtTestCheck(cwd, failedRunId);
  const failedRun = await readRunState(cwd, failedRunId);
  failedRun.stages = failedRun.stages.map((stage) =>
    stage.id === "code_review" ? { ...stage, status: "skipped" } : stage
  );
  await writeRunState(cwd, failedRun);
  const runningRunId = parseRunId((await runCli(["run"], cwd)).stdout);
  await makeInterruptedAfterStaticCheck(cwd, runningRunId);

  const status = await runCli(["status"], cwd);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(completedRunId));
  assert.match(status.stdout, new RegExp(failedRunId));
  assert.match(status.stdout, new RegExp(runningRunId));
  assert.match(status.stdout, /static_check=success/);
  assert.match(status.stdout, /test_check=failed/);
  assert.match(status.stdout, /test_check=running/);
  assert.match(status.stdout, /code_review=skipped/);
  assert.match(status.stdout, /mr_prepare=pending/);
  assert.match(status.stdout, /command_failure/);
  assert.match(status.stdout, /npm test/);
  assert.match(status.stdout, /exitCode=1/);
});

test("status reports when no runs exist", async () => {
  const cwd = await tempProject();
  const status = await runCli(["status"], cwd);

  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /No AgentMatrix runs found/);
});

test("CLI parse failures use a predictable non-zero exit code", async () => {
  const cwd = await tempProject();
  const unknown = await runCli(["unknown"], cwd);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command/);

  const missingRun = await runCli(["resume"], cwd);
  assert.equal(missingRun.code, 1);
  assert.match(missingRun.stderr, /No resumable runs/);
});
