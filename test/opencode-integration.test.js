import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const enabled = process.env.AGENTMATRIX_OPENCODE_INTEGRATION === "1";

const WORKFLOW_ROLES = [
  "static_check",
  "static_check_verifier",
  "test_check",
  "test_check_verifier",
  "code_review",
  "code_review_verifier",
  "mr_prepare",
  "mr_prepare_verifier"
];

async function tempProject() {
  const root = path.join(tmpdir(), `agentmatrix-opencode-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function runCli(args, cwd, options = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    timeout: Number(process.env.AGENTMATRIX_OPENCODE_INTEGRATION_TIMEOUT_MS ?? 20 * 60 * 1000),
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
}

function parseRunId(stdout) {
  const match = stdout.match(/Created run ([^\s]+)/);
  assert.ok(match, `Expected stdout to contain a run id, got:\n${stdout}`);
  return match[1];
}

async function writeDeterministicAgents(cwd) {
  const agentsDir = path.join(cwd, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });

  for (const role of WORKFLOW_ROLES) {
    const isVerifier = role.endsWith("_verifier");
    await writeFile(
      path.join(agentsDir, `${role}.md`),
      isVerifier ? deterministicVerifierAgent(role) : deterministicExecutorAgent(role),
      "utf8"
    );
  }
}

function deterministicExecutorAgent(role) {
  return [
    "---",
    `description: "AgentMatrix deterministic integration executor ${role}"`,
    "mode: subagent",
    "temperature: 0",
    "top_p: 1",
    "steps: 4",
    "permission:",
    "  edit: allow",
    "  bash: allow",
    "---",
    "",
    "You are a deterministic AgentMatrix integration-test executor.",
    "Do not inspect the repository or make judgement calls.",
    "Extract the JSON object from the AGENTMATRIX_CONTEXT_JSON block in the user prompt.",
    "Run exactly one `node` command with the script below, replacing `PASTE_CONTEXT_JSON_HERE` with that JSON object.",
    "Do not run tests, inspect files, or edit any other path.",
    "",
    "```js",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const context = PASTE_CONTEXT_JSON_HERE;",
    "function writeJson(relativePath, data) {",
    "  const filePath = path.join(process.cwd(), relativePath);",
    "  fs.mkdirSync(path.dirname(filePath), { recursive: true });",
    "  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\\n');",
    "}",
    "function writeText(relativePath, data) {",
    "  const filePath = path.join(process.cwd(), relativePath);",
    "  fs.mkdirSync(path.dirname(filePath), { recursive: true });",
    "  fs.writeFileSync(filePath, data);",
    "}",
    "for (const output of context.outputs) {",
    "  if (output.id !== 'stage_report') {",
    "    writeText(output.path, `deterministic output for ${output.id}\\n`);",
    "  }",
    "}",
    "writeJson(context.stage_report_path, {",
    "  schema_version: 1,",
    "  run_id: context.run_id,",
    "  stage_id: context.stage.id,",
    "  status: 'success',",
    "  summary: `deterministic opencode completed ${context.stage.id}`,",
    "  commands: [],",
    "  findings: [],",
    "  artifacts: context.outputs.map((output) => output.path),",
    "  skipped: [],",
    "  changed_files: [],",
    "  blockers: []",
    "});",
    "writeJson(context.executor_evidence_path, {",
    "  schema_version: 1,",
    "  run_id: context.run_id,",
    "  stage_id: context.stage.id,",
    "  agent_role: context.stage.agent_role,",
    "  status: 'success',",
    "  summary: 'deterministic executor completed'",
    "});",
    "```",
    ""
  ].join("\n");
}

function deterministicVerifierAgent(role) {
  return [
    "---",
    `description: "AgentMatrix deterministic integration verifier ${role}"`,
    "mode: subagent",
    "temperature: 0",
    "top_p: 1",
    "steps: 4",
    "permission:",
    "  edit: allow",
    "  bash: allow",
    "---",
    "",
    "You are a deterministic AgentMatrix integration-test verifier.",
    "Do not inspect the repository or make judgement calls.",
    "Extract the JSON object from the AGENTMATRIX_CONTEXT_JSON block in the user prompt.",
    "Run exactly one `node` command with the script below, replacing `PASTE_CONTEXT_JSON_HERE` with that JSON object.",
    "Do not run tests, inspect files, or edit any other path.",
    "",
    "```js",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const context = PASTE_CONTEXT_JSON_HERE;",
    "const filePath = path.join(process.cwd(), context.verifier_evidence_path);",
    "fs.mkdirSync(path.dirname(filePath), { recursive: true });",
    "fs.writeFileSync(filePath, JSON.stringify({",
    "  schema_version: 1,",
    "  run_id: context.run_id,",
    "  stage_id: context.stage.id,",
    "  verifier_role: context.stage.verifier_role,",
    "  accepted: true,",
    "  checked_artifact: context.stage_report_path,",
    "  summary: 'deterministic verifier accepted'",
    "}, null, 2) + '\\n');",
    "```",
    ""
  ].join("\n");
}

function opencodeRuntimeArgs() {
  const args = ["run", "--runtime", "opencode", "--opencode-bin", process.env.AGENTMATRIX_OPENCODE_BIN ?? "opencode"];

  if (process.env.AGENTMATRIX_OPENCODE_MODEL) {
    args.push("--opencode-model", process.env.AGENTMATRIX_OPENCODE_MODEL);
  }
  if (process.env.AGENTMATRIX_OPENCODE_ATTACH) {
    args.push("--opencode-attach", process.env.AGENTMATRIX_OPENCODE_ATTACH);
  }
  if (process.env.AGENTMATRIX_OPENCODE_AUTO !== "0") {
    args.push("--opencode-auto");
  }

  return args;
}

test(
  "real OpenCode executes the full mr-preflight workflow with deterministic agents",
  {
    skip: enabled ? false : "set AGENTMATRIX_OPENCODE_INTEGRATION=1 to run the real OpenCode integration test",
    timeout: Number(process.env.AGENTMATRIX_OPENCODE_INTEGRATION_TIMEOUT_MS ?? 20 * 60 * 1000)
  },
  async () => {
    const cwd = await tempProject();

    await runCli(["init", "--platform", "opencode", "--force"], cwd);
    await writeDeterministicAgents(cwd);

    const run = await runCli(opencodeRuntimeArgs(), cwd);
    const runId = parseRunId(run.stdout);
    const runState = JSON.parse(await readFile(path.join(cwd, ".agentmatrix", "runs", runId, "run.json"), "utf8"));

    assert.equal(runState.status, "success");
    assert.deepEqual(
      runState.stages.map((stage) => [stage.id, stage.status, stage.evidence.length]),
      [
        ["static_check", "success", 2],
        ["test_check", "success", 2],
        ["code_review", "success", 2],
        ["mr_prepare", "success", 2]
      ]
    );

    for (const stage of runState.stages) {
      const stageDir = path.join(cwd, runState.artifactPath, stage.id);
      const entries = await readdir(stageDir);
      assert.ok(entries.includes("stage-report.json"), `${stage.id} should write a stage report`);
      assert.ok(entries.includes("executor-evidence.json"), `${stage.id} should write executor evidence`);
      assert.ok(entries.includes("verifier-evidence.json"), `${stage.id} should write verifier evidence`);
    }

    assert.equal(await readFile(path.join(cwd, runState.artifactPath, "mr_prepare", "title.md"), "utf8"), "deterministic output for mr_title\n");
    assert.equal(
      await readFile(path.join(cwd, runState.artifactPath, "mr_prepare", "description.md"), "utf8"),
      "deterministic output for mr_description\n"
    );
  }
);
