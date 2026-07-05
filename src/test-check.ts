import { rm } from "node:fs/promises";
import path from "node:path";

import { writeProjectJson } from "./project-files.js";
import {
  createIsolatedWorkspace,
  diffSnapshots,
  readMakeTargetRecipes,
  readMakeTargets,
  readPackageScripts,
  runCommand,
  snapshotWorkspace
} from "./stage-command-utils.js";
import type {
  StageReport,
  StageReportBlocker,
  StageReportCommand,
  StageReportSkippedItem
} from "./stage-report.js";
import type { StageExecutionContext, StageExecutionResult } from "./types.js";

export interface TestCheckCommand {
  id: string;
  name: string;
  command: string;
  argv: string[];
  safetySource?: string;
}

export interface TestCheckOptions {
  commands?: TestCheckCommand[];
}

interface TestCheckPlan {
  commands: TestCheckCommand[];
  skipped: StageReportSkippedItem[];
  blockers: BlockedTestCommand[];
}

interface TestCommandExecution {
  testCommand: TestCheckCommand;
  command: StageReportCommand;
  stdout: string;
  stderr: string;
}

interface BlockedTestCommand {
  testCommand: TestCheckCommand;
  blocker: StageReportBlocker;
}

const ISOLATION_COPY_IGNORED_DIRECTORIES = new Set([
  ".agentmatrix",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);
const TEST_SCRIPT_CANDIDATES = ["test", "test:ci", "test:unit", "test:integration", "test:e2e"];

export async function executeTestCheckStage(
  context: StageExecutionContext,
  options: TestCheckOptions = {}
): Promise<StageExecutionResult> {
  const plan = options.commands ? planConfiguredCommands(options.commands) : await discoverTestCheckPlan(context.projectRoot);
  const commandExecutions = await executeTestCommands(context.projectRoot, plan.commands);
  const commands = [...commandExecutions.map((execution) => execution.command), ...plan.blockers.map(blockedCommand)];
  const failedCommands = commands.filter((command) => command.status === "failed");
  const blockers = plan.blockers.map((blocked) => blocked.blocker);
  const status = failedCommands.length > 0 || blockers.length > 0 ? "failed" : "success";
  const outputArtifactPath = path.join(path.dirname(context.stageReportPath), "test-output.json");
  const artifacts = [context.stageReportPath, outputArtifactPath];

  if (commands.length === 0 && blockers.length === 0) {
    plan.skipped.push({
      id: "test-commands",
      reason: "No repository test commands were discovered."
    });
  }

  await writeProjectJson(context.projectRoot, outputArtifactPath, {
    schema_version: 1,
    stage_id: context.stage.id,
    commands: commandExecutions.map((execution) => ({
      id: execution.testCommand.id,
      name: execution.testCommand.name,
      command: execution.testCommand.command,
      stdout: execution.stdout,
      stderr: execution.stderr
    }))
  });

  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status,
    summary: testCheckSummary(status, commands, plan.skipped, plan.blockers),
    commands,
    findings: testCheckFindings(commandExecutions, plan.blockers),
    artifacts,
    skipped: plan.skipped,
    changed_files: [],
    blockers
  };

  await writeProjectJson(context.projectRoot, context.executorEvidencePath, {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    agent_role: context.stage.agentRole,
    status,
    summary: report.summary,
    commands
  });
  await writeProjectJson(context.projectRoot, context.stageReportPath, report);

  return {
    stageReportPath: context.stageReportPath,
    evidencePath: context.executorEvidencePath
  };
}

async function executeTestCommands(projectRoot: string, commands: TestCheckCommand[]) {
  const executions: TestCommandExecution[] = [];

  for (const testCommand of commands) {
    executions.push(await executeTestCommand(projectRoot, testCommand));
  }

  return executions;
}

async function executeTestCommand(projectRoot: string, testCommand: TestCheckCommand): Promise<TestCommandExecution> {
  const isolatedRoot = await createIsolatedWorkspace(
    projectRoot,
    "agentmatrix-test-check",
    ISOLATION_COPY_IGNORED_DIRECTORIES,
    { linkNodeModules: true }
  );
  const startedAt = Date.now();

  try {
    const before = await snapshotWorkspace(isolatedRoot, ISOLATION_COPY_IGNORED_DIRECTORIES);
    const result = await runCommand(testCommand.argv, isolatedRoot, projectRoot);
    const changedFiles = diffSnapshots(
      before,
      await snapshotWorkspace(isolatedRoot, ISOLATION_COPY_IGNORED_DIRECTORIES)
    ).filter(isExpectationArtifactPath);
    const status = result.exitCode === 0 && changedFiles.length === 0 ? "success" : "failed";
    const summary =
      changedFiles.length > 0
        ? `Test command changed files in isolated workspace: ${changedFiles.join(", ")}.`
        : commandSummary(status, result.stdout, result.stderr);

    return {
      testCommand,
      stdout: result.stdout,
      stderr: result.stderr,
      command: {
        name: testCommand.name,
        command: testCommand.command,
        status,
        exit_code: changedFiles.length > 0 && result.exitCode === 0 ? 1 : result.exitCode,
        duration_ms: Date.now() - startedAt,
        summary
      }
    };
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true });
  }
}

function planConfiguredCommands(commands: TestCheckCommand[]): TestCheckPlan {
  return partitionSafeCommands(commands);
}

async function discoverTestCheckPlan(projectRoot: string): Promise<TestCheckPlan> {
  const scripts = await readPackageScripts(projectRoot);
  const makeTargets = await readMakeTargets(projectRoot);
  const makeRecipes = await readMakeTargetRecipes(projectRoot);
  const commands: TestCheckCommand[] = [];

  for (const scriptName of TEST_SCRIPT_CANDIDATES) {
    const scriptBody = scripts[scriptName];
    if (scriptBody) {
      commands.push({
        id: `script:${scriptName}`,
        name: testCommandName(scriptName),
        command: `npm run ${scriptName}`,
        argv: ["npm", "run", scriptName],
        safetySource: scriptBody
      });
    }
  }

  for (const target of TEST_SCRIPT_CANDIDATES) {
    if (makeTargets.has(target) && !commands.some((command) => command.id === `make:${target}`)) {
      commands.push({
        id: `make:${target}`,
        name: testCommandName(target),
        command: `make ${target}`,
        argv: ["make", target],
        safetySource: makeRecipes.get(target) ?? target
      });
    }
  }

  return partitionSafeCommands(commands);
}

function partitionSafeCommands(commands: TestCheckCommand[]): TestCheckPlan {
  const safeCommands: TestCheckCommand[] = [];
  const blockers: BlockedTestCommand[] = [];

  for (const command of commands) {
    if (isExpectationUpdatingCommand(command)) {
      blockers.push({
        testCommand: command,
        blocker: {
          type: "human_required",
          message: `Refusing to run expectation-updating test command: ${command.command}.`
        }
      });
      continue;
    }

    safeCommands.push(command);
  }

  return {
    commands: safeCommands,
    skipped: [],
    blockers
  };
}

function blockedCommand(blocked: BlockedTestCommand): StageReportCommand {
  return {
    name: blocked.testCommand.name,
    command: blocked.testCommand.command,
    status: "skipped",
    reason: "Command appears to update snapshots, generated expectations, or test assertions."
  };
}

function isExpectationUpdatingCommand(command: TestCheckCommand) {
  const source = `${command.command}\n${command.argv.join("\n")}\n${command.safetySource ?? ""}`.toLowerCase();
  const tokens = source.split(/\s+/).filter(Boolean);

  return (
    tokens.some((token) => token === "-u" || token === "--update" || token === "--updatesnapshot") ||
    [
      "update-snapshot",
      "updatesnapshot",
      "snapshot:update",
      "update snapshot",
      "update-golden",
      "golden:update",
      "update-fixture",
      "fixture:update",
      "approve",
      "bless"
    ].some((pattern) => source.includes(pattern))
  );
}

function isExpectationArtifactPath(relativePath: string) {
  const normalized = relativePath.toLowerCase();
  const basename = path.posix.basename(normalized);

  return (
    normalized.includes("__snapshots__/") ||
    normalized.includes("/snapshots/") ||
    normalized.includes("/snapshot/") ||
    normalized.includes("/golden/") ||
    normalized.includes("/goldens/") ||
    normalized.includes("/fixtures/") ||
    normalized.includes("/fixture/") ||
    basename.includes("snapshot") ||
    basename.includes("golden") ||
    basename.includes("fixture") ||
    basename.endsWith(".snap")
  );
}

function testCommandName(scriptName: string) {
  if (scriptName === "test") {
    return "Test";
  }

  return scriptName
    .replace(/^test:/, "Test ")
    .replace(/[-:]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function testCheckFindings(executions: TestCommandExecution[], blockers: BlockedTestCommand[]): Record<string, unknown>[] {
  return [
    ...executions
      .filter((execution) => execution.command.status === "failed")
      .map((execution) => ({
        severity: "blocker",
        source: "test",
        message: execution.command.summary ?? `Test command "${execution.testCommand.command}" failed.`
      })),
    ...blockers.map(({ blocker }) => ({
      severity: "blocker",
      source: "test",
      message: blocker.message
    }))
  ];
}

function testCheckSummary(
  status: StageReport["status"],
  commands: StageReportCommand[],
  skipped: StageReportSkippedItem[],
  blockers: BlockedTestCommand[]
) {
  if (blockers.length > 0) {
    return `Test execution blocked: ${blockers[0].blocker.message}`;
  }

  if (status === "failed") {
    const failed = commands.filter((command) => command.status === "failed").length;
    return `Tests failed: ${failed} command${failed === 1 ? "" : "s"} failed.`;
  }

  if (commands.length === 0) {
    return skipped[0]?.reason ?? "No repository test commands were discovered.";
  }

  return `Tests passed: ${commands.length} command${commands.length === 1 ? "" : "s"} succeeded.`;
}

function commandSummary(status: StageReportCommand["status"], stdout: string, stderr: string) {
  if (status === "success") {
    return firstOutputLine(stdout) ?? "Test command completed successfully.";
  }

  return firstOutputLine(stderr) ?? firstOutputLine(stdout) ?? "Test command failed.";
}

function firstOutputLine(output: string) {
  return output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean);
}
