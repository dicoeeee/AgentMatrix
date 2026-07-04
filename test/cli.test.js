import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
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
    assert.equal(typeof stage.agent_role, "string");
    assert.equal(typeof stage.verifier_role, "string");
    assert.ok(Array.isArray(stage.skills), `${stage.id} should declare platform-visible skills`);
    assert.equal(Object.hasOwn(stage, "command"), false, `${stage.id} should not define a command abstraction`);
  }

  const skillNames = workflow.stages.flatMap((stage) => stage.skills);
  assert.ok(skillNames.includes("static-check"));
  assert.ok(skillNames.includes("industry-code-review"));
});

test("run always creates a fresh filesystem-backed run", async () => {
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

  const runState = JSON.parse(
    await readFile(path.join(cwd, ".agentmatrix", "runs", firstRunId, "run.json"), "utf8")
  );
  assert.equal(runState.workflowId, "mr-preflight");
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status]),
    [
      ["static_check", "pending"],
      ["test_check", "pending"],
      ["code_review", "pending"],
      ["mr_prepare", "pending"]
    ]
  );
});

test("resume, status, and visualize expose run state", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);
  const runId = parseRunId((await runCli(["run"], cwd)).stdout);

  const status = await runCli(["status"], cwd);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(runId));
  assert.match(status.stdout, /pending/);

  const resume = await runCli(["resume", runId], cwd);
  assert.equal(resume.code, 0, resume.stderr);
  assert.match(resume.stdout, new RegExp(`Resumed run ${runId}`));

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
      ["static_check", "pending"],
      ["test_check", "pending"],
      ["code_review", "pending"],
      ["mr_prepare", "pending"]
    ]
  );
  assert.deepEqual(graph.edges, [
    { from: "static_check", to: "test_check" },
    { from: "test_check", to: "code_review" },
    { from: "code_review", to: "mr_prepare" }
  ]);
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
