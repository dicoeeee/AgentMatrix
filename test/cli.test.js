import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const { runCli: runCliInProcess } = await import("../dist/cli.js");

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

async function runCli(args, cwd, options = {}) {
  if (Object.hasOwn(options, "input")) {
    return runCliWithInput(args, cwd, options.input);
  }

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

async function runCliWithInput(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr
      });
    });
    child.stdin.end(input);
  });
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function createFakeOpencode(cwd) {
  const executable = path.join(cwd, "fake-opencode.js");
  const logPath = path.join(cwd, "opencode-calls.jsonl");

  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const agent = args[args.indexOf("--agent") + 1];
const dir = args[args.indexOf("--dir") + 1];
const match = /AGENTMATRIX_CONTEXT_JSON\\n([\\s\\S]*?)\\nEND_AGENTMATRIX_CONTEXT_JSON/.exec(prompt);

if (!match) {
  console.error("missing AgentMatrix context");
  process.exit(2);
}

const context = JSON.parse(match[1]);
await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ agent, kind: context.kind, stage_id: context.stage.id }) + "\\n");
console.log(\`fake opencode stdout \${context.kind} \${context.stage.id}\`);
console.error(\`fake opencode stderr \${context.kind} \${context.stage.id}\`);

async function writeJson(relativePath, data) {
  const filePath = path.join(dir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\\n");
}

async function writeText(relativePath, data) {
  const filePath = path.join(dir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
}

if (context.kind === "stage_verification") {
  await writeJson(context.verifier_evidence_path, {
    schema_version: 1,
    run_id: context.run_id,
    stage_id: context.stage.id,
    verifier_role: context.stage.verifier_role,
    accepted: true,
    checked_artifact: context.stage_report_path,
    summary: "fake verifier accepted"
  });
  process.exit(0);
}

for (const output of context.outputs) {
  if (output.id !== "stage_report") {
    await writeText(output.path, \`fake output for \${output.id}\\n\`);
  }
}

await writeJson(context.stage_report_path, {
  schema_version: 1,
  run_id: context.run_id,
  stage_id: context.stage.id,
  status: "success",
  summary: \`fake opencode completed \${context.stage.id}\`,
  commands: [],
  findings: [],
  artifacts: context.outputs.map((output) => output.path),
  skipped: [],
  changed_files: [],
  blockers: []
});
await writeJson(context.executor_evidence_path, {
  schema_version: 1,
  run_id: context.run_id,
  stage_id: context.stage.id,
  agent_role: context.stage.agent_role,
  status: "success",
  summary: "fake executor completed"
});
`,
    "utf8"
  );
  await chmod(executable, 0o755);
  return { executable, logPath };
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

async function writeProjectJson(cwd, relativePath, data) {
  const filePath = path.join(cwd, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function writeProjectText(cwd, relativePath, data) {
  const filePath = path.join(cwd, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, data);
}

async function writeDriverStageReport(cwd, invocation, overrides = {}) {
  await writeProjectJson(cwd, invocation.stage_report_path, {
    schema_version: 1,
    run_id: invocation.run_id,
    stage_id: invocation.stage_id,
    status: "success",
    summary: `${invocation.stage_id} subagent completed.`,
    commands: [],
    findings: [],
    artifacts: [invocation.stage_report_path],
    skipped: [],
    changed_files: [],
    blockers: [],
    ...overrides
  });
}

async function writeDriverExecutorEvidence(cwd, invocation, overrides = {}) {
  await writeProjectJson(cwd, invocation.executor_evidence_path, {
    schema_version: 1,
    run_id: invocation.run_id,
    stage_id: invocation.stage_id,
    agent_role: invocation.agent_role,
    status: "success",
    summary: `${invocation.stage_id} executor completed.`,
    ...overrides
  });
}

async function writeDriverVerifierEvidence(cwd, invocation, overrides = {}) {
  await writeProjectJson(cwd, invocation.verifier_evidence_path, {
    schema_version: 1,
    run_id: invocation.run_id,
    stage_id: invocation.stage_id,
    verifier_role: invocation.agent_role,
    accepted: true,
    checked_artifact: invocation.stage_report_path,
    summary: `${invocation.stage_id} verifier accepted.`,
    ...overrides
  });
}

async function readJsonLines(filePath) {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

  const initHelp = await runCli(["init", "--help"], cwd);
  assert.equal(initHelp.code, 0, initHelp.stderr);
  assert.match(initHelp.stdout, /--platform opencode/);
  assert.match(initHelp.stdout, /OpenCode Run Driver and stage agent templates/);
  assert.match(initHelp.stdout, /--force/);
});

test("help output works when the CLI is invoked through a symlinked bin path", async () => {
  const cwd = await tempProject();
  const linkedBinPath = path.join(cwd, "agentmatrix");
  await symlink(cliPath, linkedBinPath);

  const direct = await runCli(["--help"], cwd);
  const linked = await execFileAsync(process.execPath, [linkedBinPath, "--help"], { cwd });

  assert.equal(linked.stdout, direct.stdout);
  assert.equal(linked.stderr, "");
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

test("init pre-seeds bundled skill templates declared by mr-preflight", async () => {
  const cwd = await tempProject();
  const result = await runCli(["init"], cwd);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Skill templates: created 2, skipped 0/);

  const skillsDir = path.join(cwd, ".agentmatrix", "skills");
  assert.deepEqual((await readdir(skillsDir)).sort(), ["industry-code-review", "static-check"]);

  const staticCheck = await readFile(path.join(skillsDir, "static-check", "SKILL.md"), "utf8");
  assert.match(staticCheck, /name: static-check/);
  assert.equal(await exists(path.join(skillsDir, "static-check", "references", "typescript.md")), true);

  const codeReview = await readFile(path.join(skillsDir, "industry-code-review", "SKILL.md"), "utf8");
  assert.match(codeReview, /name: industry-code-review/);
  assert.equal(await exists(path.join(skillsDir, "industry-code-review", "references", "dynamic-routing.md")), true);
});

test("init preserves existing pre-seeded skill templates", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const skillPath = path.join(cwd, ".agentmatrix", "skills", "static-check", "SKILL.md");
  await writeFile(skillPath, "custom static check skill\n");

  const second = await runCli(["init"], cwd);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Skill templates: created 0, skipped 2/);
  assert.equal(await readFile(skillPath, "utf8"), "custom static check skill\n");
});

test("init --platform opencode creates a primary driver and stage subagent templates", async () => {
  const cwd = await tempProject();
  const result = await runCli(["init", "--platform", "opencode"], cwd);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /OpenCode agent templates: created 9, skipped 0/);

  const agentsDir = path.join(cwd, ".opencode", "agents");
  const entries = (await readdir(agentsDir)).sort();
  assert.deepEqual(entries, [
    "agentmatrix_driver.md",
    "code_review.md",
    "code_review_verifier.md",
    "mr_prepare.md",
    "mr_prepare_verifier.md",
    "static_check.md",
    "static_check_verifier.md",
    "test_check.md",
    "test_check_verifier.md"
  ]);

  const driver = await readFile(path.join(agentsDir, "agentmatrix_driver.md"), "utf8");
  assert.match(driver, /description: "AgentMatrix OpenCode Run Driver"/);
  assert.match(driver, /mode: primary/);
  assert.doesNotMatch(driver, /mode: subagent/);
  assert.match(driver, /Keep the driver thin/);
  assert.match(
    driver,
    /AgentMatrix core owns workflow state, dependency checks, completion criteria, verifier results, rerun invalidation, and resume semantics/
  );
  assert.match(driver, /deterministic JSON Driver Protocol/);
  assert.match(driver, /agentmatrix driver start/);
  assert.match(driver, /agentmatrix driver resume/);
  assert.match(driver, /agentmatrix driver status/);
  assert.match(driver, /agentmatrix driver next/);
  assert.match(driver, /agentmatrix driver prepare-executor/);
  assert.match(driver, /agentmatrix driver validate-executor/);
  assert.match(driver, /agentmatrix driver prepare-verifier/);
  assert.match(driver, /agentmatrix driver complete-stage/);
  assert.match(driver, /agentmatrix driver record-event/);
  assert.match(driver, /core records deterministic Run Trace boundaries automatically/);
  assert.match(driver, /Record only compact platform summaries/);
  assert.match(driver, /executor subagent invocation/);
  assert.match(driver, /verifier subagent invocation/);
  assert.match(driver, /checker shard count/);
  assert.match(driver, /notable command summaries/);
  assert.match(driver, /executor\.log/);
  assert.match(driver, /verifier\.log/);
  assert.match(driver, /subagents/);
  assert.match(driver, /Automatically continue through successful stages/);
  assert.match(driver, /Stop on failures, blockers, verifier rejection, or explicit user request/);
  assert.match(driver, /Do not duplicate workflow logic/);

  const staticCheck = await readFile(path.join(agentsDir, "static_check.md"), "utf8");
  assert.match(staticCheck, /description: "AgentMatrix executor for static_check"/);
  assert.match(staticCheck, /mode: subagent/);
  assert.doesNotMatch(staticCheck, /mode: primary/);
  assert.doesNotMatch(staticCheck, /record-event/);
  assert.match(staticCheck, /\.agentmatrix\/skills\/static-check\/SKILL\.md/);
  assert.match(staticCheck, /safe mechanical repairs/);

  const testCheck = await readFile(path.join(agentsDir, "test_check.md"), "utf8");
  assert.match(testCheck, /description: "AgentMatrix executor for test_check"/);
  assert.match(testCheck, /mode: subagent/);
  assert.match(testCheck, /tools:/);
  assert.match(testCheck, /write: true/);
  assert.match(testCheck, /AGENTMATRIX_CONTEXT_JSON/);

  const codeReview = await readFile(path.join(agentsDir, "code_review.md"), "utf8");
  assert.match(codeReview, /mode: subagent/);
  assert.match(codeReview, /\.agentmatrix\/skills\/industry-code-review\/SKILL\.md/);

  const verifier = await readFile(path.join(agentsDir, "static_check_verifier.md"), "utf8");
  assert.match(verifier, /description: "AgentMatrix verifier for static_check"/);
  assert.match(verifier, /mode: subagent/);
  assert.match(verifier, /write: true/);
  assert.match(verifier, /bash: false/);
  assert.doesNotMatch(verifier, /record-event/);
  assert.match(verifier, /Write only the verifier evidence JSON/);
  assert.match(verifier, /Executor role under review: `static_check`/);
});

test("init --platform opencode is idempotent and reports skipped templates", async () => {
  const cwd = await tempProject();
  const first = await runCli(["init", "--platform", "opencode"], cwd);
  const templatePath = path.join(cwd, ".opencode", "agents", "static_check_verifier.md");
  const firstTemplate = await readFile(templatePath, "utf8");

  const second = await runCli(["init", "--platform", "opencode"], cwd);
  const secondTemplate = await readFile(templatePath, "utf8");

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /OpenCode agent templates: created 0, skipped 9/);
  assert.equal(secondTemplate, firstTemplate);
});

test("init --platform opencode preserves existing templates unless force is passed", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);

  const templatePath = path.join(cwd, ".opencode", "agents", "test_check.md");
  const configPath = path.join(cwd, ".agentmatrix", "config.json");
  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const initialConfig = await readFile(configPath, "utf8");
  const editedWorkflow = `${await readFile(workflowPath, "utf8")}\n# user comment\n`;
  await writeFile(templatePath, "custom test_check template\n");
  await writeFile(workflowPath, editedWorkflow);

  const preserved = await runCli(["init", "--platform", "opencode"], cwd);
  assert.equal(preserved.code, 0, preserved.stderr);
  assert.match(preserved.stdout, /OpenCode agent templates: created 0, skipped 9/);
  assert.equal(await readFile(templatePath, "utf8"), "custom test_check template\n");
  assert.equal(await readFile(configPath, "utf8"), initialConfig);
  assert.equal(await readFile(workflowPath, "utf8"), editedWorkflow);

  const forced = await runCli(["init", "--platform", "opencode", "--force"], cwd);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /OpenCode agent templates: created 9, skipped 0/);
  assert.match(await readFile(templatePath, "utf8"), /AgentMatrix executor for test_check/);
  assert.equal(await readFile(configPath, "utf8"), initialConfig);
  assert.equal(await readFile(workflowPath, "utf8"), editedWorkflow);
});

test("init --platform opencode merges workflow resources into config", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const configPath = path.join(cwd, ".agentmatrix", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.availableResources = {
    agents: ["custom_agent", "static_check"],
    skills: ["custom_skill"],
    mcpResources: ["custom_mcp"]
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

  const result = await runCli(["init", "--platform", "opencode"], cwd);
  assert.equal(result.code, 0, result.stderr);

  const updated = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(updated.availableResources.agents, [
    "custom_agent",
    "static_check",
    "static_check_verifier",
    "test_check",
    "test_check_verifier",
    "code_review",
    "code_review_verifier",
    "mr_prepare",
    "mr_prepare_verifier"
  ]);
  assert.equal(updated.availableResources.agents.includes("agentmatrix_driver"), false);
  assert.deepEqual(updated.availableResources.skills, ["custom_skill", "static-check", "industry-code-review"]);
  assert.deepEqual(updated.availableResources.mcpResources, ["custom_mcp", "github"]);
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
  assert.equal(config.availableResources.agents.includes("static_check"), false);
  assert.ok(config.availableResources.agents.includes("static_check_verifier"));
  assert.ok(config.availableResources.skills.includes("static-check"));
  assert.deepEqual(config.availableResources.mcpResources, []);
});

test("driver protocol starts an interactive run and prepares the static_check executor invocation", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);

  const start = await runCli(["driver", "start"], cwd);
  assert.equal(start.code, 0, start.stderr);
  const started = JSON.parse(start.stdout);
  assert.equal(started.status, "running");
  assert.equal(started.next_stage_id, "static_check");
  assert.equal(started.next_action, "prepare_executor");

  const runState = await readRunState(cwd, started.run_id);
  assert.equal(runState.status, "running");
  assert.deepEqual(
    runState.stages.map((stage) => [stage.id, stage.status]),
    [
      ["static_check", "pending"],
      ["test_check", "pending"],
      ["code_review", "pending"],
      ["mr_prepare", "pending"]
    ]
  );

  const prepared = JSON.parse((await runCli(["driver", "prepare-executor", started.run_id], cwd)).stdout);
  assert.equal(prepared.next_action, "invoke_subagent");
  assert.equal(prepared.stage_invocation.kind, "stage_invocation");
  assert.equal(prepared.stage_invocation.invocation_kind, "executor");
  assert.equal(prepared.stage_invocation.agent_role, "static_check");
  assert.equal(prepared.stage_invocation.platform_role, "subagent");
  assert.deepEqual(prepared.stage_invocation.expected_output_paths, [
    {
      id: "stage_report",
      path: path.join(".agentmatrix", "artifacts", started.run_id, "static_check", "stage-report.json"),
      required: true,
      schema: "stage_report"
    }
  ]);
  assert.deepEqual(prepared.stage_invocation.expected_evidence_paths, [
    path.join(".agentmatrix", "artifacts", started.run_id, "static_check", "executor-evidence.json")
  ]);
  assert.deepEqual(prepared.stage_invocation.stage_log_paths, {
    executor_log_path: path.join(".agentmatrix", "artifacts", started.run_id, "static_check", "executor.log"),
    verifier_log_path: path.join(".agentmatrix", "artifacts", started.run_id, "static_check", "verifier.log"),
    child_subagent_log_dir: path.join(".agentmatrix", "artifacts", started.run_id, "static_check", "subagents")
  });
  assert.deepEqual(prepared.stage_invocation.required_skill_paths, [
    ".agentmatrix/skills/static-check/SKILL.md"
  ]);
  assert.deepEqual(prepared.stage_invocation.context.stage, {
    id: "static_check",
    name: "Static Check",
    depends_on: [],
    agent_role: "static_check",
    verifier_role: "static_check_verifier",
    skills: ["static-check"],
    mcp_resources: []
  });
  assert.deepEqual(prepared.stage_invocation.context.completion_criteria, [
    { type: "output_exists", output: "stage_report" },
    { type: "schema_valid", output: "stage_report", schema: "stage_report" },
    { type: "commands_ok" },
    { type: "no_blockers" },
    { type: "skip_reason_present" }
  ]);
  assert.deepEqual(prepared.stage_invocation.context.repair_policy, {
    allow_repair: true,
    max_attempts: 1,
    writes_allowed: true
  });
  assert.deepEqual(prepared.stage_invocation.context.required_skill_paths, [
    ".agentmatrix/skills/static-check/SKILL.md"
  ]);
  assert.deepEqual(prepared.stage_invocation.context.stage_log_paths, prepared.stage_invocation.stage_log_paths);
  assert.equal(prepared.stage_invocation.change_scope.status, "unknown");
  assert.equal(prepared.stage_invocation.change_scope.reason, "Project is not inside a git work tree.");
  assert.deepEqual(prepared.stage_invocation.change_scope.files, []);
  assert.deepEqual(prepared.stage_invocation.change_scope.diff_summary, {
    files_changed: 0,
    additions: 0,
    deletions: 0,
    lines_changed: 0,
    entries: []
  });
  assert.match(prepared.stage_invocation.prompt, /safe mechanical repairs/);
  assert.match(prepared.stage_invocation.prompt, /AGENTMATRIX_CONTEXT_JSON/);

  const afterPrepare = await readRunState(cwd, started.run_id);
  assert.equal(afterPrepare.stages[0].status, "running");
  assert.deepEqual(
    afterPrepare.events.map((event) => [event.type, event.stageId ?? null]),
    [
      ["run_created", null],
      ["run_started", null],
      ["stage_started", "static_check"]
    ]
  );
});

test("driver protocol reports status, next stage, and resumable run state", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;

  const status = JSON.parse((await runCli(["driver", "status", runId], cwd)).stdout);
  assert.equal(status.run_status, "running");
  assert.equal(status.next_action, "prepare_executor");
  assert.equal(status.next_stage_id, "static_check");

  const next = JSON.parse((await runCli(["driver", "next", runId], cwd)).stdout);
  assert.equal(next.run_status, "running");
  assert.equal(next.next_action, "prepare_executor");
  assert.equal(next.next_stage_id, "static_check");
  assert.deepEqual(next.next_stage, {
    id: "static_check",
    name: "Static Check",
    status: "pending",
    agent_role: "static_check",
    verifier_role: "static_check_verifier",
    expected_artifact_paths: [
      path.join(".agentmatrix", "artifacts", runId, "static_check", "stage-report.json")
    ],
    expected_evidence_paths: [
      path.join(".agentmatrix", "artifacts", runId, "static_check", "executor-evidence.json"),
      path.join(".agentmatrix", "artifacts", runId, "static_check", "verifier-evidence.json")
    ]
  });
  assert.equal(next.stage_invocation.kind, "stage_invocation");
  assert.equal(next.stage_invocation.invocation_kind, "executor");
  assert.equal(next.stage_invocation.stage_id, "static_check");
  assert.equal(next.stage_invocation.agent_role, "static_check");

  const afterNext = await readRunState(cwd, runId);
  assert.equal(afterNext.stages[0].status, "pending");

  const resumed = JSON.parse((await runCli(["driver", "resume", runId], cwd)).stdout);
  assert.equal(resumed.run_status, "running");
  assert.equal(resumed.next_action, "prepare_executor");
  assert.equal(resumed.next_stage_id, "static_check");

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.events.some((event) => event.type === "resume_requested"), true);
});

test("driver protocol errors return structured JSON", async () => {
  const cwd = await tempProject();
  const result = await runCli(["driver", "next", "missing-run"], cwd);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const error = JSON.parse(result.stdout);
  assert.equal(error.schema_version, 1);
  assert.equal(error.kind, "driver_protocol_error");
  assert.equal(error.exit_code, 1);
  assert.match(error.message, /Run "missing-run" was not found/);

  const usage = await runCli(["driver", "complete-stage", "missing-run"], cwd);
  assert.equal(usage.code, 2);
  assert.equal(usage.stderr, "");
  const usageError = JSON.parse(usage.stdout);
  assert.equal(usageError.kind, "driver_protocol_error");
  assert.equal(usageError.exit_code, 2);
  assert.match(usageError.message, /requires --stage/);
});

test("driver protocol validates executor output, prepares verifier work, and completes one stage", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const prepared = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout);
  const invocation = prepared.stage_invocation;

  await writeProjectJson(cwd, invocation.stage_report_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    status: "success",
    summary: "Static-check subagent completed.",
    commands: [
      {
        name: "Typecheck",
        command: "npm run typecheck",
        status: "success",
        exit_code: 0
      }
    ],
    findings: [],
    artifacts: [invocation.stage_report_path],
    skipped: [],
    changed_files: [],
    blockers: []
  });
  await writeProjectJson(cwd, invocation.executor_evidence_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    agent_role: "static_check",
    status: "success",
    summary: "Static-check subagent completed."
  });

  const validated = JSON.parse((await runCli(["driver", "validate-executor", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(validated.next_action, "prepare_verifier");
  assert.equal(validated.stage_id, "static_check");

  const verifier = JSON.parse((await runCli(["driver", "prepare-verifier", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(verifier.stage_invocation.invocation_kind, "verifier");
  assert.equal(verifier.stage_invocation.agent_role, "static_check_verifier");
  assert.equal(verifier.stage_invocation.platform_role, "subagent");
  assert.match(
    verifier.stage_invocation.prompt,
    /Validate the report schema, run and stage identity, evidence presence, failed commands, blockers, unexplained out-of-scope changes, obvious scope omissions, and changed-file reporting/
  );
  assert.match(verifier.stage_invocation.prompt, /Do not rerun the full static-check workload/);

  await writeProjectJson(cwd, verifier.stage_invocation.verifier_evidence_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    verifier_role: "static_check_verifier",
    accepted: true,
    checked_artifact: invocation.stage_report_path,
    summary: "Verifier accepted static_check."
  });

  const completed = JSON.parse((await runCli(["driver", "complete-stage", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(completed.stage_status, "success");
  assert.equal(completed.run_status, "running");
  assert.equal(completed.next_stage_id, "test_check");
  assert.equal(completed.next_action, "prepare_executor");

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.stages[0].status, "success");
  assert.deepEqual(runState.stages[0].artifacts, [invocation.stage_report_path]);
  assert.deepEqual(runState.stages[0].evidence, [
    invocation.executor_evidence_path,
    verifier.stage_invocation.verifier_evidence_path
  ]);
});

test("driver protocol stops when verifier evidence rejects a stage", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const invocation = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout).stage_invocation;

  await writeProjectJson(cwd, invocation.stage_report_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    status: "success",
    summary: "Static-check subagent completed.",
    commands: [],
    findings: [],
    artifacts: [invocation.stage_report_path],
    skipped: [],
    changed_files: [],
    blockers: []
  });
  await writeProjectJson(cwd, invocation.executor_evidence_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    agent_role: "static_check",
    status: "success"
  });

  const validated = await runCli(["driver", "validate-executor", runId, "--stage", "static_check"], cwd);
  assert.equal(validated.code, 0, validated.stderr);
  const verifier = JSON.parse((await runCli(["driver", "prepare-verifier", runId, "--stage", "static_check"], cwd)).stdout);
  await writeProjectJson(cwd, verifier.stage_invocation.verifier_evidence_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    verifier_role: "static_check_verifier",
    accepted: false,
    checked_artifact: invocation.stage_report_path,
    summary: "Verifier rejected fixture output."
  });

  const completed = JSON.parse((await runCli(["driver", "complete-stage", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(completed.run_status, "failed");
  assert.equal(completed.next_action, "stop");
  assert.equal(completed.failure.kind, "verifier_failure");

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.status, "failed");
  assert.equal(runState.stages[0].status, "failed");
  assert.equal(runState.stages[0].failure.kind, "verifier_failure");
  assert.equal(runState.stages[1].status, "pending");
});

test("driver protocol completes a skipped stage after verifier acceptance", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const invocation = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout).stage_invocation;

  await writeDriverStageReport(cwd, invocation, {
    status: "skipped",
    summary: "Static-check subagent found no supported checks.",
    skipped: [
      {
        id: "static-gates",
        reason: "No static check gates were discovered."
      }
    ]
  });
  await writeDriverExecutorEvidence(cwd, invocation);

  const validated = JSON.parse((await runCli(["driver", "validate-executor", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(validated.next_action, "prepare_verifier");

  const verifier = JSON.parse((await runCli(["driver", "prepare-verifier", runId, "--stage", "static_check"], cwd)).stdout);
  await writeDriverVerifierEvidence(cwd, verifier.stage_invocation);

  const completed = JSON.parse((await runCli(["driver", "complete-stage", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(completed.stage_status, "skipped");
  assert.equal(completed.run_status, "running");
  assert.equal(completed.next_stage_id, "test_check");
  assert.equal(completed.next_action, "prepare_executor");

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.stages[0].status, "skipped");
  assert.deepEqual(runState.stages[0].artifacts, [invocation.stage_report_path]);
  assert.deepEqual(runState.stages[0].evidence, [
    invocation.executor_evidence_path,
    verifier.stage_invocation.verifier_evidence_path
  ]);
  assert.equal(runState.stages[1].status, "pending");
});

test("driver protocol records run trace milestones and visualize --open renders a run detail view", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;

  for (const stageId of ["static_check", "test_check", "code_review", "mr_prepare"]) {
    const prepared = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout);
    assert.equal(prepared.stage_id, stageId);
    const invocation = prepared.stage_invocation;

    await writeDriverStageReport(cwd, invocation, {
      summary: `${stageId} executor passed.`,
      commands: [
        {
          name: `${stageId} checks`,
          command: `npm run ${stageId}`,
          status: "success",
          exit_code: 0
        }
      ]
    });
    for (const output of invocation.expected_output_paths.filter((output) => output.id !== "stage_report")) {
      await writeProjectText(cwd, output.path, `${output.id} for ${stageId}\n`);
    }
    await writeDriverExecutorEvidence(cwd, invocation, {
      summary: `${stageId} executor evidence accepted.`
    });

    const validated = JSON.parse((await runCli(["driver", "validate-executor", runId, "--stage", stageId], cwd)).stdout);
    assert.equal(validated.stage_id, stageId);
    assert.equal(validated.next_action, "prepare_verifier");

    const verifier = JSON.parse((await runCli(["driver", "prepare-verifier", runId, "--stage", stageId], cwd)).stdout);
    await writeDriverVerifierEvidence(cwd, verifier.stage_invocation, {
      summary: `${stageId} verifier accepted.`
    });

    const completed = JSON.parse((await runCli(["driver", "complete-stage", runId, "--stage", stageId], cwd)).stdout);
    assert.equal(completed.stage_id, stageId);
  }

  const tracePath = path.join(cwd, ".agentmatrix", "runs", runId, "trace.jsonl");
  const trace = await readJsonLines(tracePath);
  assert.deepEqual(trace.map((event) => event.kind), [
    "run_started",
    "stage_prepared",
    "executor_validated",
    "verifier_prepared",
    "verifier_completed",
    "stage_completed",
    "stage_prepared",
    "executor_validated",
    "verifier_prepared",
    "verifier_completed",
    "stage_completed",
    "stage_prepared",
    "executor_validated",
    "verifier_prepared",
    "verifier_completed",
    "stage_completed",
    "stage_prepared",
    "executor_validated",
    "verifier_prepared",
    "verifier_completed",
    "stage_completed",
    "run_completed"
  ]);
  assert.ok(trace.every((event) => event.schema_version === 1));
  assert.ok(trace.every((event) => event.run_id === runId));
  assert.ok(trace.every((event) => typeof event.at === "string" && event.at.length > 0));

  const staticPrepared = trace.find((event) => event.kind === "stage_prepared" && event.stage_id === "static_check");
  assert.deepEqual(staticPrepared.paths, {
    stage_report_path: path.join(".agentmatrix", "artifacts", runId, "static_check", "stage-report.json"),
    executor_evidence_path: path.join(".agentmatrix", "artifacts", runId, "static_check", "executor-evidence.json")
  });

  const staticExecutorValidated = trace.find(
    (event) => event.kind === "executor_validated" && event.stage_id === "static_check"
  );
  assert.equal(staticExecutorValidated.status, "success");
  assert.match(staticExecutorValidated.summary, /static_check executor passed/);

  const staticVerifierCompleted = trace.find(
    (event) => event.kind === "verifier_completed" && event.stage_id === "static_check"
  );
  assert.equal(staticVerifierCompleted.status, "success");
  assert.deepEqual(staticVerifierCompleted.paths, {
    stage_report_path: path.join(".agentmatrix", "artifacts", runId, "static_check", "stage-report.json"),
    verifier_evidence_path: path.join(".agentmatrix", "artifacts", runId, "static_check", "verifier-evidence.json")
  });

  assert.equal(trace.at(-1).kind, "run_completed");
  assert.equal(trace.at(-1).status, "success");

  const mermaid = await runCli(["visualize", runId], cwd);
  assert.equal(mermaid.code, 0, mermaid.stderr);
  assert.match(mermaid.stdout, /graph TD/);
  assert.match(mermaid.stdout, /static_check \(success\)/);

  const json = await runCli(["visualize", runId, "--format", "json"], cwd);
  assert.equal(json.code, 0, json.stderr);
  const graph = JSON.parse(json.stdout);
  assert.equal(graph.kind, "run");
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

  const stdout = [];
  const stderr = [];
  const previousDisableOpen = process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN;
  process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN = "1";

  try {
    const code = await runCliInProcess(["--project", cwd, "visualize", runId, "--open"], {
      stdout: {
        write(message) {
          stdout.push(message);
        }
      },
      stderr: {
        write(message) {
          stderr.push(message);
        }
      }
    });

    assert.equal(code, 0, stderr.join(""));
  } finally {
    if (previousDisableOpen === undefined) {
      delete process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN;
    } else {
      process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN = previousDisableOpen;
    }
  }

  assert.match(stdout.join(""), /graph TD/);
  assert.match(stderr.join(""), /Wrote visualization HTML: \.agentmatrix\/visualizations\/run-/);

  const html = await readFile(path.join(cwd, ".agentmatrix", "visualizations", `run-${runId}.html`), "utf8");
  assert.match(html, /Run Detail View/);
  assert.match(html, /Stage Flow/);
  assert.match(html, /Static Check/);
  assert.match(html, /Executor Validated/);
  assert.match(html, /Verifier Completed/);
  assert.match(html, /Run Completed/);
  assert.match(html, /static_check executor passed/);
  assert.match(html, /stage-report\.json/);
});

test("driver record-event appends platform summaries and run detail HTML renders them", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const invocation = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout).stage_invocation;

  const agentEvent = {
    stage_id: "static_check",
    kind: "agent_invoked",
    status: "running",
    label: "OpenCode executor subagent invoked",
    summary: "Primary driver invoked the static_check OpenCode subagent.",
    paths: {
      executor_log_path: invocation.stage_log_paths.executor_log_path
    }
  };
  const recordedAgent = JSON.parse(
    (
      await runCli(["driver", "record-event", runId], cwd, {
        input: JSON.stringify(agentEvent)
      })
    ).stdout
  );
  assert.equal(recordedAgent.kind, "driver_protocol_result");
  assert.equal(recordedAgent.recorded_event.kind, "agent_invoked");
  assert.equal(recordedAgent.recorded_event.run_id, runId);
  assert.equal(recordedAgent.recorded_event.schema_version, 1);
  assert.equal(recordedAgent.recorded_event.stage_id, "static_check");
  assert.equal(typeof recordedAgent.recorded_event.at, "string");
  assert.ok(recordedAgent.recorded_event.at.length > 0);

  const commandAt = "2026-07-07T12:34:56.000Z";
  const commandEvent = {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    kind: "command_completed",
    status: "success",
    label: "npm run lint",
    summary: "Lint completed without embedding stdout.",
    at: commandAt
  };
  const recordedCommand = JSON.parse(
    (
      await runCli(["driver", "record-event", runId], cwd, {
        input: JSON.stringify(commandEvent)
      })
    ).stdout
  );
  assert.equal(recordedCommand.recorded_event.at, commandAt);

  const verifierEvent = {
    stage_id: "static_check",
    kind: "agent_invoked",
    status: "success",
    label: "OpenCode verifier subagent invoked",
    summary: "Primary driver invoked the static_check_verifier OpenCode subagent.",
    paths: {
      verifier_log_path: invocation.stage_log_paths.verifier_log_path
    }
  };
  assert.equal(
    JSON.parse(
      (
        await runCli(["driver", "record-event", runId], cwd, {
          input: JSON.stringify(verifierEvent)
        })
      ).stdout
    ).recorded_event.kind,
    "agent_invoked"
  );

  const childSubagentLogPath = path.join(invocation.stage_log_paths.child_subagent_log_dir, "checker-1.log");
  const shardEvent = {
    stage_id: "static_check",
    kind: "command_completed",
    status: "success",
    label: "Checker shard 1 completed",
    summary: "Checker shard count: 1.",
    paths: {
      child_subagent_log_path: childSubagentLogPath
    }
  };
  assert.equal(
    JSON.parse(
      (
        await runCli(["driver", "record-event", runId], cwd, {
          input: JSON.stringify(shardEvent)
        })
      ).stdout
    ).recorded_event.kind,
    "command_completed"
  );

  const tracePath = path.join(cwd, ".agentmatrix", "runs", runId, "trace.jsonl");
  const trace = await readJsonLines(tracePath);
  assert.deepEqual(
    trace.map((event) => event.kind),
    ["run_started", "stage_prepared", "agent_invoked", "command_completed", "agent_invoked", "command_completed"]
  );
  assert.deepEqual(trace[2], recordedAgent.recorded_event);
  assert.deepEqual(trace[3], recordedCommand.recorded_event);

  await writeDriverStageReport(cwd, invocation);
  await writeDriverExecutorEvidence(cwd, invocation);
  await writeProjectText(cwd, invocation.stage_log_paths.executor_log_path, "FULL EXECUTOR LOG CONTENT\n");
  await writeProjectText(cwd, invocation.stage_log_paths.verifier_log_path, "FULL VERIFIER LOG CONTENT\n");
  await writeProjectText(cwd, childSubagentLogPath, "FULL CHILD SUBAGENT LOG CONTENT\n");
  assert.equal((await runCli(["driver", "validate-executor", runId, "--stage", "static_check"], cwd)).code, 0);

  const stdout = [];
  const stderr = [];
  const previousDisableOpen = process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN;
  process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN = "1";

  try {
    const code = await runCliInProcess(["--project", cwd, "visualize", runId, "--open"], {
      stdout: {
        write(message) {
          stdout.push(message);
        }
      },
      stderr: {
        write(message) {
          stderr.push(message);
        }
      }
    });

    assert.equal(code, 0, stderr.join(""));
  } finally {
    if (previousDisableOpen === undefined) {
      delete process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN;
    } else {
      process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN = previousDisableOpen;
    }
  }

  assert.match(stdout.join(""), /graph TD/);
  const html = await readFile(path.join(cwd, ".agentmatrix", "visualizations", `run-${runId}.html`), "utf8");
  assert.match(html, /Agent Invoked/);
  assert.match(html, /Command Completed/);
  assert.match(html, /OpenCode executor subagent invoked/);
  assert.match(html, /OpenCode verifier subagent invoked/);
  assert.match(html, /Checker shard 1 completed/);
  assert.match(html, /Primary driver invoked the static_check OpenCode subagent/);
  assert.match(html, /npm run lint/);
  assert.match(html, /Lint completed without embedding stdout/);
  assert.doesNotMatch(html, /stdout:/);
  assert.match(html, /executor\.log/);
  assert.match(html, /verifier\.log/);
  assert.match(html, /subagents\/checker-1\.log/);
  assert.doesNotMatch(html, /FULL EXECUTOR LOG CONTENT/);
  assert.doesNotMatch(html, /FULL VERIFIER LOG CONTENT/);
  assert.doesNotMatch(html, /FULL CHILD SUBAGENT LOG CONTENT/);
});

test("driver record-event rejects malformed and invalid platform summary events", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;

  const malformed = await runCli(["driver", "record-event", runId], cwd, { input: "{" });
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stderr, "");
  assert.equal(JSON.parse(malformed.stdout).kind, "driver_protocol_error");
  assert.match(JSON.parse(malformed.stdout).message, /invalid JSON/);

  const missingRun = await runCli(["driver", "record-event", "missing-run"], cwd, {
    input: JSON.stringify({
      kind: "agent_invoked",
      label: "OpenCode subagent invoked"
    })
  });
  assert.equal(missingRun.code, 1);
  assert.match(JSON.parse(missingRun.stdout).message, /Run "missing-run" was not found/);

  const invalidKind = await runCli(["driver", "record-event", runId], cwd, {
    input: JSON.stringify({
      kind: "unknown_event",
      label: "Unknown event"
    })
  });
  assert.equal(invalidKind.code, 1);
  assert.match(JSON.parse(invalidKind.stdout).message, /kind/);

  const invalidStage = await runCli(["driver", "record-event", runId], cwd, {
    input: JSON.stringify({
      stage_id: "missing_stage",
      kind: "agent_invoked",
      label: "OpenCode subagent invoked"
    })
  });
  assert.equal(invalidStage.code, 1);
  assert.match(JSON.parse(invalidStage.stdout).message, /does not contain stage "missing_stage"/);

  const mismatchedRun = await runCli(["driver", "record-event", runId], cwd, {
    input: JSON.stringify({
      schema_version: 1,
      run_id: "other-run",
      kind: "agent_invoked",
      label: "OpenCode subagent invoked"
    })
  });
  assert.equal(mismatchedRun.code, 1);
  assert.match(JSON.parse(mismatchedRun.stdout).message, /run_id must match/);

  for (const unsupportedField of ["actor", "source", "metadata"]) {
    const unsupported = await runCli(["driver", "record-event", runId], cwd, {
      input: JSON.stringify({
        kind: "agent_invoked",
        label: "OpenCode subagent invoked",
        [unsupportedField]: {}
      })
    });
    assert.equal(unsupported.code, 1);
    assert.match(JSON.parse(unsupported.stdout).message, /Unsupported Run Trace event field/);
  }
});

test("driver protocol invalidates stale stages after a repaired stage reports changed files or artifacts", async () => {
  for (const repairReport of [
    {
      summary: "Test-check subagent repaired source and passed.",
      changed_files: ["src/fixed.ts"]
    },
    {
      summary: "Test-check subagent refreshed a prior artifact and passed.",
      changed_artifacts: ["static_check/stage-report.json"]
    }
  ]) {
    const cwd = await tempProject();
    assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
    const run = await runCli(["run"], cwd);
    assert.equal(run.code, 0, run.stderr);
    const runId = parseRunId(run.stdout);
    await makeFailedAtTestCheck(cwd, runId);

    const resumed = JSON.parse((await runCli(["driver", "resume", runId], cwd)).stdout);
    assert.equal(resumed.run_status, "running");
    assert.equal(resumed.next_stage_id, "test_check");

    const invocation = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout).stage_invocation;
    assert.equal(invocation.stage_id, "test_check");
    await writeDriverStageReport(cwd, invocation, repairReport);
    await writeDriverExecutorEvidence(cwd, invocation);

    const validated = JSON.parse((await runCli(["driver", "validate-executor", runId, "--stage", "test_check"], cwd)).stdout);
    assert.equal(validated.next_action, "prepare_verifier");

    const verifier = JSON.parse((await runCli(["driver", "prepare-verifier", runId, "--stage", "test_check"], cwd)).stdout);
    await writeDriverVerifierEvidence(cwd, verifier.stage_invocation);

    const completed = JSON.parse((await runCli(["driver", "complete-stage", runId, "--stage", "test_check"], cwd)).stdout);
    assert.equal(completed.run_status, "running");
    assert.equal(completed.stage_id, "test_check");
    assert.equal(completed.stage_status, "pending");
    assert.equal(completed.next_stage_id, "static_check");
    assert.equal(completed.next_action, "prepare_executor");

    const runState = await readRunState(cwd, runId);
    assert.deepEqual(
      runState.stages.map((stage) => [stage.id, stage.status]),
      [
        ["static_check", "pending"],
        ["test_check", "pending"],
        ["code_review", "pending"],
        ["mr_prepare", "pending"]
      ]
    );
    assert.deepEqual(runState.stages[0].evidence, []);
    assert.deepEqual(runState.stages[1].evidence, []);
  }
});

test("driver protocol blocks static_check repairs outside the Change Scope", async () => {
  const cwd = await tempProject();
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "agentmatrix@example.com"]);
  await git(cwd, ["config", "user.name", "AgentMatrix Test"]);
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  await writeProjectText(cwd, "src/in-scope.ts", "export const value = 1;\n");
  await writeProjectText(cwd, "src/out-of-scope.ts", "export const other = 1;\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "baseline"]);
  await git(cwd, ["checkout", "-b", "feature/static-repair"]);
  await writeProjectText(cwd, "src/in-scope.ts", "export const value = 2;\n");

  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const invocation = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout).stage_invocation;
  assert.deepEqual(invocation.change_scope.files, ["src/in-scope.ts"]);

  await writeProjectJson(cwd, invocation.stage_report_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    status: "success",
    summary: "Static-check subagent repaired a file outside the scope.",
    commands: [],
    findings: [],
    artifacts: [invocation.stage_report_path],
    skipped: [],
    changed_files: ["src/out-of-scope.ts"],
    blockers: []
  });
  await writeProjectJson(cwd, invocation.executor_evidence_path, {
    schema_version: 1,
    run_id: runId,
    stage_id: "static_check",
    agent_role: "static_check",
    status: "success"
  });

  const validated = JSON.parse((await runCli(["driver", "validate-executor", runId, "--stage", "static_check"], cwd)).stdout);
  assert.equal(validated.run_status, "failed");
  assert.equal(validated.next_action, "stop");
  assert.equal(validated.failure.kind, "human_required_blocker");
  assert.deepEqual(validated.failure.metadata.outOfScopeChangedFiles, ["src/out-of-scope.ts"]);

  const runState = await readRunState(cwd, runId);
  assert.equal(runState.status, "failed");
  assert.equal(runState.stages[0].status, "failed");
});

test("driver protocol change scope separates branch, staged, unstaged, and untracked changes", async () => {
  const cwd = await tempProject();
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "agentmatrix@example.com"]);
  await git(cwd, ["config", "user.name", "AgentMatrix Test"]);
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  await writeProjectText(cwd, "src/committed.ts", "export const committed = 1;\n");
  await writeProjectText(cwd, "src/unstaged.ts", "export const unstaged = 1;\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "baseline"]);
  await git(cwd, ["checkout", "-b", "feature/change-scope"]);

  await writeProjectText(
    cwd,
    "src/committed.ts",
    "export const committed = 2;\nexport const committedAgain = true;\n"
  );
  await git(cwd, ["add", "src/committed.ts"]);
  await git(cwd, ["commit", "-m", "commit branch change"]);

  await writeProjectText(cwd, "src/staged.ts", "export const staged = 1;\nexport const stagedAgain = true;\n");
  await git(cwd, ["add", "src/staged.ts"]);

  await writeProjectText(cwd, "src/unstaged.ts", "export const unstaged = 2;\n");
  await writeProjectText(cwd, "src/untracked.ts", "export const untracked = 1;\n");

  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const next = JSON.parse((await runCli(["driver", "next", runId], cwd)).stdout);
  const scope = next.stage_invocation.change_scope;

  assert.equal(scope.status, "known");
  assert.equal(scope.current_branch, "feature/change-scope");
  assert.equal(scope.default_branch, "main");
  assert.deepEqual(scope.files, [
    "src/committed.ts",
    "src/staged.ts",
    "src/unstaged.ts",
    "src/untracked.ts"
  ]);
  assert.deepEqual(scope.sources, {
    committed_files: ["src/committed.ts"],
    staged_files: ["src/staged.ts"],
    unstaged_files: ["src/unstaged.ts"],
    untracked_files: ["src/untracked.ts"]
  });
  assert.deepEqual(
    scope.diff_summary.entries.map((entry) => [
      entry.source,
      entry.path,
      entry.additions,
      entry.deletions
    ]),
    [
      ["committed", "src/committed.ts", 2, 1],
      ["staged", "src/staged.ts", 2, 0],
      ["unstaged", "src/unstaged.ts", 1, 1],
      ["untracked", "src/untracked.ts", 1, 0]
    ]
  );
  assert.equal(scope.diff_summary.files_changed, 4);
  assert.equal(scope.diff_summary.additions, 6);
  assert.equal(scope.diff_summary.deletions, 2);
  assert.equal(scope.diff_summary.lines_changed, 8);
  assert.equal(scope.large_change.is_large, false);
  assert.deepEqual(scope.suggested_check_shards, []);
});

test("driver protocol includes git change scope, large-change hints, and check shards", async () => {
  const cwd = await tempProject();
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "agentmatrix@example.com"]);
  await git(cwd, ["config", "user.name", "AgentMatrix Test"]);
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  await writeProjectText(cwd, "src/baseline.ts", "export const baseline = 1;\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "baseline"]);
  await git(cwd, ["checkout", "-b", "feature/driver"]);

  for (let index = 0; index < 9; index += 1) {
    await writeProjectText(cwd, `src/change-${index}.ts`, `export const change${index} = ${index};\n`);
  }

  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const prepared = JSON.parse((await runCli(["driver", "prepare-executor", runId], cwd)).stdout);
  const scope = prepared.stage_invocation.change_scope;

  assert.equal(scope.status, "known");
  assert.equal(scope.default_branch, "main");
  assert.equal(scope.files.length, 9);
  assert.ok(scope.files.includes("src/change-0.ts"));
  assert.deepEqual(scope.sources.untracked_files.sort(), [
    "src/change-0.ts",
    "src/change-1.ts",
    "src/change-2.ts",
    "src/change-3.ts",
    "src/change-4.ts",
    "src/change-5.ts",
    "src/change-6.ts",
    "src/change-7.ts",
    "src/change-8.ts"
  ]);
  assert.equal(scope.large_change.is_large, true);
  assert.match(scope.large_change.reasons.join(" "), /9 changed files/);
  assert.ok(prepared.stage_invocation.suggested_check_shards.length > 0);
  assert.equal(prepared.stage_invocation.suggested_check_shards[0].files.length, 9);

  assert.equal(prepared.stage_invocation.agent_role, "static_check");
  assert.equal(prepared.stage_invocation.platform_role, "subagent");
  assert.equal(prepared.stage_invocation.context.static_check.skill_path, ".agentmatrix/skills/static-check/SKILL.md");
  assert.deepEqual(prepared.stage_invocation.context.static_check.language_references, [
    {
      id: "typescript",
      name: "TypeScript",
      path: ".agentmatrix/skills/static-check/references/typescript.md",
      matches: [
        "src/change-0.ts",
        "src/change-1.ts",
        "src/change-2.ts",
        "src/change-3.ts",
        "src/change-4.ts",
        "src/change-5.ts",
        "src/change-6.ts",
        "src/change-7.ts",
        "src/change-8.ts"
      ]
    }
  ]);
  assert.match(
    prepared.stage_invocation.context.static_check.changed_file_reporting,
    /stage_report\.changed_files/
  );
  assert.match(
    prepared.stage_invocation.context.static_check.repair_limits.safe_mechanical_changes.join(" "),
    /formatter output/
  );
  assert.match(
    prepared.stage_invocation.context.static_check.repair_limits.blockers.join(" "),
    /Behavior changes/
  );
  assert.match(prepared.stage_invocation.prompt, /Record every repaired file exactly in stage_report\.changed_files/);
  assert.doesNotMatch(prepared.stage_invocation.prompt, /built-in scheduler/);
});

test("driver protocol marks large changes by changed line count", async () => {
  const cwd = await tempProject();
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "agentmatrix@example.com"]);
  await git(cwd, ["config", "user.name", "AgentMatrix Test"]);
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  await writeProjectText(cwd, "README.md", "baseline\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "baseline"]);
  await git(cwd, ["checkout", "-b", "feature/large-line-scope"]);

  await writeProjectText(
    cwd,
    "src/large.ts",
    Array.from({ length: 500 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n"
  );

  const runId = JSON.parse((await runCli(["driver", "start"], cwd)).stdout).run_id;
  const next = JSON.parse((await runCli(["driver", "next", runId], cwd)).stdout);
  const scope = next.stage_invocation.change_scope;

  assert.equal(scope.status, "known");
  assert.deepEqual(scope.files, ["src/large.ts"]);
  assert.equal(scope.diff_summary.files_changed, 1);
  assert.equal(scope.diff_summary.additions, 500);
  assert.equal(scope.diff_summary.lines_changed, 500);
  assert.equal(scope.large_change.is_large, true);
  assert.match(scope.large_change.reasons.join(" "), /500 changed lines/);
  assert.deepEqual(scope.suggested_check_shards, [
    {
      id: "typescript",
      name: "TypeScript",
      files: ["src/large.ts"],
      rationale: "Inspect 1 typescript file together."
    }
  ]);
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
    if (stage.id === "static_check") {
      assert.equal(stageReport.summary, "Static check found no runnable static gates.");
      assert.deepEqual(stageReport.commands, []);
      assert.deepEqual(stageReport.skipped, [
        {
          id: "static-gates",
          reason: "No static check gates were discovered."
        }
      ]);
      assert.ok(stageReport.artifacts.includes(path.join(runState.artifactPath, "static_check", "language-references.json")));
      assert.deepEqual(
        (await readProjectJson(cwd, path.join(runState.artifactPath, "static_check", "language-references.json")))
          .languages,
        []
      );
    } else if (stage.id === "test_check") {
      assert.equal(stageReport.summary, "No repository test commands were discovered.");
      assert.deepEqual(stageReport.commands, []);
      assert.deepEqual(stageReport.skipped, [
        {
          id: "test-commands",
          reason: "No repository test commands were discovered."
        }
      ]);
      assert.ok(stageReport.artifacts.includes(path.join(runState.artifactPath, "test_check", "test-output.json")));
      assert.deepEqual(
        (await readProjectJson(cwd, path.join(runState.artifactPath, "test_check", "test-output.json"))).commands,
        []
      );
    } else if (stage.id === "code_review") {
      assert.equal(stageReport.summary, "Code review found no actionable findings across 6 reviewer lanes.");
      assert.deepEqual(
        stageReport.commands.map((command) => [command.command, command.status, command.parallel_group]),
        [
          ["review:correctness", "success", "code-review-lanes-1"],
          ["review:security", "success", "code-review-lanes-1"],
          ["review:maintainability", "success", "code-review-lanes-1"],
          ["review:performance", "success", "code-review-lanes-1"],
          ["review:data", "success", "code-review-lanes-1"],
          ["review:api", "success", "code-review-lanes-1"]
        ]
      );
      assert.deepEqual(stageReport.findings, []);
      assert.deepEqual(stageReport.skipped, []);
    } else if (stage.id === "mr_prepare") {
      assert.equal(stageReport.summary, "Generated MR title and description from 3 prior stage reports.");
      assert.deepEqual(stageReport.commands, []);
      assert.deepEqual(stageReport.findings, []);
      assert.deepEqual(stageReport.skipped, []);
      assert.equal(
        await readFile(path.join(cwd, runState.artifactPath, "mr_prepare", "title.md"), "utf8"),
        "MR: validation passed\n"
      );
      const description = await readFile(
        path.join(cwd, runState.artifactPath, "mr_prepare", "description.md"),
        "utf8"
      );
      assert.match(description, /Generated from 3 workflow stage reports\./);
      assert.match(description, /No MR, PR, reviewer, label, push, or CI-watch action was performed\./);
    } else {
      assert.equal(stageReport.summary, `Mock executor completed ${stage.id}.`);
      assert.deepEqual(stageReport.skipped, []);
    }
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

test("run can execute through the opencode runtime adapter", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const { executable, logPath } = await createFakeOpencode(cwd);

  const run = await runCli(["run", "--runtime", "opencode", "--opencode-bin", executable], cwd);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Completed run/);

  const runId = parseRunId(run.stdout);
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

  const calls = await readJsonLines(logPath);
  assert.deepEqual(
    calls.map((call) => call.agent),
    [
      "static_check_verifier",
      "test_check",
      "test_check_verifier",
      "code_review",
      "code_review_verifier",
      "mr_prepare",
      "mr_prepare_verifier"
    ]
  );
  assert.equal(calls.some((call) => call.agent === "static_check" && call.kind === "stage_execution"), false);
});

test("run --runtime opencode --verbose prints opencode command details", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init", "--platform", "opencode"], cwd)).code, 0);
  const { executable } = await createFakeOpencode(cwd);

  const normal = await runCli(["run", "--runtime", "opencode", "--opencode-bin", executable], cwd);
  assert.equal(normal.code, 0, normal.stderr);
  assert.doesNotMatch(normal.stdout, /fake opencode stdout/);
  assert.doesNotMatch(normal.stdout, /fake opencode stderr/);

  const verbose = await runCli(
    ["run", "--runtime", "opencode", "--opencode-bin", executable, "--verbose"],
    cwd
  );
  assert.equal(verbose.code, 0, verbose.stderr);
  assert.doesNotMatch(verbose.stdout, /\[opencode:executor\] stage=static_check agent=static_check/);
  assert.match(verbose.stdout, /\[opencode:verifier\] stage=static_check agent=static_check_verifier exit=0/);
  assert.match(verbose.stdout, /stderr:\nfake opencode stderr stage_verification static_check/);
  assert.match(verbose.stdout, /Completed run/);
});

test("run --runtime opencode validates platform agent definitions before creating a run", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);
  const { executable } = await createFakeOpencode(cwd);

  const result = await runCli(["run", "--runtime", "opencode", "--opencode-bin", executable], cwd);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing OpenCode agent definitions/);
  assert.match(result.stderr, /agent: static_check_verifier/);
  assert.doesNotMatch(result.stderr, /agent: static_check\n/);
  assert.match(result.stderr, /\.opencode\/agents\/static_check_verifier\.md/);
  assert.match(result.stderr, /opencode\.json agent\.static_check_verifier/);
  assert.match(result.stderr, /agentmatrix init --platform opencode/);
  assert.deepEqual(await readdir(path.join(cwd, ".agentmatrix", "runs")), []);
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
  assert.match(result.stderr, /agent: static_check_verifier/);
  assert.doesNotMatch(result.stderr, /agent: static_check\n/);
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

test("visualize renders persisted run state when the edited workflow is invalid", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);
  const runId = parseRunId((await runCli(["run"], cwd)).stdout);

  const workflowPath = path.join(cwd, ".agentmatrix", "workflows", "mr-preflight.workflow.yml");
  const validWorkflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, validWorkflow.replace("    verifier_role: static_check_verifier", "    verifier_role: opencode/static_check_verifier"));

  const runGraph = await runCli(["visualize", runId], cwd);
  assert.equal(runGraph.code, 0, runGraph.stderr);
  assert.match(runGraph.stdout, /static_check \(success\)/);

  const workflowGraph = await runCli(["visualize", "--workflow", "mr-preflight"], cwd);
  assert.equal(workflowGraph.code, 1);
  assert.match(workflowGraph.stderr, /mr-preflight\.workflow\.yml/);
  assert.match(workflowGraph.stderr, /stages\[0\]\.verifier_role/);
});

test("visualize renders static workflow definitions as Mermaid and JSON", async () => {
  const cwd = await tempProject();
  assert.equal((await runCli(["init"], cwd)).code, 0);

  const mermaid = await runCli(["visualize", "--workflow", "mr-preflight"], cwd);
  assert.equal(mermaid.code, 0, mermaid.stderr);
  assert.match(mermaid.stdout, /graph TD/);
  assert.match(mermaid.stdout, /static_check/);
  assert.match(mermaid.stdout, /mr_prepare/);
  assert.doesNotMatch(mermaid.stdout, /static_check \(pending\)/);
  assert.doesNotMatch(mermaid.stdout, /run-/);

  const json = await runCli(["visualize", "--workflow", "mr-preflight", "--format", "json"], cwd);
  assert.equal(json.code, 0, json.stderr);
  const graph = JSON.parse(json.stdout);
  assert.equal(graph.kind, "workflow");
  assert.equal(graph.workflowId, "mr-preflight");
  assert.equal(Object.hasOwn(graph, "runId"), false);
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, Object.hasOwn(node, "status")]),
    [
      ["static_check", false],
      ["test_check", false],
      ["code_review", false],
      ["mr_prepare", false]
    ]
  );
  assert.deepEqual(graph.edges, [
    { from: "static_check", to: "test_check" },
    { from: "test_check", to: "code_review" },
    { from: "code_review", to: "mr_prepare" }
  ]);
});

test("visualize renders real run state statuses as Mermaid and JSON", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  const runState = await readRunState(cwd, runId);
  runState.status = "running";
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
          message: 'Stage "test_check" command failed: npm test.'
        }
      };
    }
    if (stage.id === "code_review") {
      return { ...stage, status: "skipped" };
    }
    return { ...stage, status: "running" };
  });
  await writeRunState(cwd, runState);

  const mermaid = await runCli(["visualize", runId], cwd);
  assert.equal(mermaid.code, 0, mermaid.stderr);
  assert.match(mermaid.stdout, /static_check \(success\)/);
  assert.match(mermaid.stdout, /test_check \(failed\)/);
  assert.match(mermaid.stdout, /code_review \(skipped\)/);
  assert.match(mermaid.stdout, /mr_prepare \(running\)/);
  assert.match(mermaid.stdout, /class stage_1 failed;/);
  assert.match(mermaid.stdout, /class stage_2 skipped;/);
  assert.match(mermaid.stdout, /class stage_3 running;/);

  const json = await runCli(["visualize", runId, "--format", "json"], cwd);
  assert.equal(json.code, 0, json.stderr);
  const graph = JSON.parse(json.stdout);
  assert.equal(graph.kind, "run");
  assert.equal(graph.runId, runId);
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.status]),
    [
      ["static_check", "success"],
      ["test_check", "failed"],
      ["code_review", "skipped"],
      ["mr_prepare", "running"]
    ]
  );

  const pendingRunId = await createCompletedRun(cwd);
  await makeInterruptedAfterStaticCheck(cwd, pendingRunId);

  const pendingMermaid = await runCli(["visualize", pendingRunId], cwd);
  assert.equal(pendingMermaid.code, 0, pendingMermaid.stderr);
  assert.match(pendingMermaid.stdout, /test_check \(running\)/);
  assert.match(pendingMermaid.stdout, /code_review \(pending\)/);
  assert.match(pendingMermaid.stdout, /class stage_2 pending;/);

  const pendingJson = await runCli(["visualize", pendingRunId, "--format", "json"], cwd);
  assert.equal(pendingJson.code, 0, pendingJson.stderr);
  assert.deepEqual(
    JSON.parse(pendingJson.stdout).nodes.map((node) => [node.id, node.status]),
    [
      ["static_check", "success"],
      ["test_check", "running"],
      ["code_review", "pending"],
      ["mr_prepare", "pending"]
    ]
  );
});

test("visualize renders parallel stage report commands inside the run graph", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);

  const mermaid = await runCli(["visualize", runId], cwd);
  assert.equal(mermaid.code, 0, mermaid.stderr);
  assert.match(mermaid.stdout, /parallel group: code-review-lanes-1/);
  assert.match(mermaid.stdout, /Correctness Review/);
  assert.match(mermaid.stdout, /Security Review/);
  assert.match(mermaid.stdout, /class stage_2_activity_0 parallelActivity;/);
});

test("visualize renders background subagents from opencode executor evidence", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  const runState = await readRunState(cwd, runId);
  const codeReview = runState.stages.find((stage) => stage.id === "code_review");
  assert.ok(codeReview);

  const taskEvent = (description, backgroundTaskId) =>
    JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {
            description,
            run_in_background: true
          },
          metadata: {
            subagent: "Sisyphus-Junior",
            backgroundTaskId,
            category: "quick"
          }
        }
      }
    });

  await writeFile(
    path.join(cwd, codeReview.evidence[0]),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        stage_id: "code_review",
        agent_role: "code_review",
        status: "success",
        stdout: `${taskEvent("Find changed files for review", "bg_36da9cb8")}\n${taskEvent(
          "Read prior stage reports",
          "bg_060e0ba0"
        )}\n`
      },
      null,
      2
    ) + "\n"
  );

  const mermaid = await runCli(["visualize", runId], cwd);
  assert.equal(mermaid.code, 0, mermaid.stderr);
  assert.match(mermaid.stdout, /parallel group: opencode-background-subagents/);
  assert.match(mermaid.stdout, /Find changed files for review/);
  assert.match(mermaid.stdout, /Sisyphus-Junior/);
  assert.match(mermaid.stdout, /bg_36da9cb8/);
});

test("visualize auto-generates browser HTML for interactive Mermaid output", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  const stdout = [];
  const stderr = [];
  const previousDisableOpen = process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN;
  process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN = "1";

  try {
    const code = await runCliInProcess(["--project", cwd, "visualize", runId], {
      stdout: {
        isTTY: true,
        write(message) {
          stdout.push(message);
        }
      },
      stderr: {
        write(message) {
          stderr.push(message);
        }
      }
    });

    assert.equal(code, 0, stderr.join(""));
  } finally {
    if (previousDisableOpen === undefined) {
      delete process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN;
    } else {
      process.env.AGENTMATRIX_DISABLE_BROWSER_OPEN = previousDisableOpen;
    }
  }

  assert.match(stdout.join(""), /graph TD/);
  assert.match(stderr.join(""), /Wrote visualization HTML: \.agentmatrix\/visualizations\/run-/);

  const htmlPath = path.join(cwd, ".agentmatrix", "visualizations", `run-${runId}.html`);
  assert.equal(await exists(htmlPath), true);
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<title>AgentMatrix run/);
  assert.match(html, /class="mermaid diagram"/);
  assert.match(html, /static_check \(success\)/);
  assert.match(html, /mermaid@11/);
  assert.match(html, /htmlLabels: true/);
  assert.match(html, /themeVariables/);
});

test("visualize --no-open suppresses interactive browser HTML generation", async () => {
  const cwd = await tempProject();
  const runId = await createCompletedRun(cwd);
  const stdout = [];
  const stderr = [];

  const code = await runCliInProcess(["--project", cwd, "visualize", runId, "--no-open"], {
    stdout: {
      isTTY: true,
      write(message) {
        stdout.push(message);
      }
    },
    stderr: {
      write(message) {
        stderr.push(message);
      }
    }
  });

  assert.equal(code, 0, stderr.join(""));
  assert.match(stdout.join(""), /graph TD/);
  assert.equal(stderr.join(""), "");
  assert.equal(await exists(path.join(cwd, ".agentmatrix", "visualizations", `run-${runId}.html`)), false);
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

  const latestJson = await runCli(["visualize", "--format", "json"], cwd);
  assert.equal(latestJson.code, 0, latestJson.stderr);
  assert.equal(JSON.parse(latestJson.stdout).runId, runId);
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

  const missingWorkflow = await runCli(["visualize", "--workflow", "--format", "json"], cwd);
  assert.equal(missingWorkflow.code, 2);
  assert.match(missingWorkflow.stderr, /Missing value for --workflow/);

  const jsonOpen = await runCli(["visualize", "--format", "json", "--open"], cwd);
  assert.equal(jsonOpen.code, 2);
  assert.match(jsonOpen.stderr, /Cannot combine --open with --format json/);
});
