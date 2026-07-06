import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

test("init --platform opencode creates templates for platform-managed mr-preflight roles", async () => {
  const cwd = await tempProject();
  const result = await runCli(["init", "--platform", "opencode"], cwd);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /OpenCode agent templates: created 7, skipped 0/);

  const agentsDir = path.join(cwd, ".opencode", "agents");
  const entries = (await readdir(agentsDir)).sort();
  assert.deepEqual(entries, [
    "code_review.md",
    "code_review_verifier.md",
    "mr_prepare.md",
    "mr_prepare_verifier.md",
    "static_check_verifier.md",
    "test_check.md",
    "test_check_verifier.md"
  ]);

  const testCheck = await readFile(path.join(agentsDir, "test_check.md"), "utf8");
  assert.match(testCheck, /description: "AgentMatrix executor for test_check"/);
  assert.match(testCheck, /tools:/);
  assert.match(testCheck, /write: true/);
  assert.match(testCheck, /AGENTMATRIX_CONTEXT_JSON/);

  const codeReview = await readFile(path.join(agentsDir, "code_review.md"), "utf8");
  assert.match(codeReview, /\.agentmatrix\/skills\/industry-code-review\/SKILL\.md/);

  const verifier = await readFile(path.join(agentsDir, "static_check_verifier.md"), "utf8");
  assert.match(verifier, /description: "AgentMatrix verifier for static_check"/);
  assert.match(verifier, /write: true/);
  assert.match(verifier, /bash: false/);
  assert.match(verifier, /Write only the verifier evidence JSON/);
  assert.match(verifier, /AgentMatrix built-in scheduler for `static_check`/);
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
  assert.match(second.stdout, /OpenCode agent templates: created 0, skipped 7/);
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
  assert.match(preserved.stdout, /OpenCode agent templates: created 0, skipped 7/);
  assert.equal(await readFile(templatePath, "utf8"), "custom test_check template\n");
  assert.equal(await readFile(configPath, "utf8"), initialConfig);
  assert.equal(await readFile(workflowPath, "utf8"), editedWorkflow);

  const forced = await runCli(["init", "--platform", "opencode", "--force"], cwd);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /OpenCode agent templates: created 7, skipped 0/);
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
