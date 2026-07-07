import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { writeProjectJson } from "./project-files.js";
import {
  createIsolatedWorkspace,
  diffSnapshots,
  readMakeTargets,
  readPackageScripts,
  runCommand,
  snapshotWorkspace,
  type WorkspaceSnapshot
} from "./stage-command-utils.js";
import type { StageReport, StageReportCommand, StageReportSkippedItem } from "./stage-report.js";
import {
  selectStaticCheckLanguageReferences,
  type StaticCheckLanguageReference
} from "./static-check-references.js";
import type { StageExecutionContext, StageExecutionResult } from "./types.js";

export type StaticCheckGateMode = "read-only" | "writer";
export type StaticCheckGateKind = "lint" | "typecheck" | "formatter" | "security" | "dependency" | "static";

export interface StaticCheckGate {
  id: string;
  name: string;
  kind: StaticCheckGateKind;
  command: string;
  argv: string[];
  mode: StaticCheckGateMode;
}

export interface StaticCheckOptions {
  gates?: StaticCheckGate[];
}

interface StaticCheckPlan {
  gates: StaticCheckGate[];
  skipped: StageReportSkippedItem[];
}

interface CommandExecution {
  gate: StaticCheckGate;
  command: StageReportCommand;
  stdout: string;
  stderr: string;
  changedFiles: string[];
}

const WORKSPACE_IGNORED_DIRECTORIES = new Set([
  ".agentmatrix",
  ".git",
  "node_modules"
]);
const ISOLATION_COPY_IGNORED_DIRECTORIES = new Set([
  ...WORKSPACE_IGNORED_DIRECTORIES,
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "target"
]);

export async function executeStaticCheckStage(
  context: StageExecutionContext,
  options: StaticCheckOptions = {}
): Promise<StageExecutionResult> {
  const projectFiles = await listProjectFiles(context.projectRoot);
  const languages = selectStaticCheckLanguageReferences(projectFiles);
  const plan = options.gates ? { gates: options.gates, skipped: [] } : await discoverStaticCheckPlan(context.projectRoot);

  if (plan.gates.length === 0) {
    plan.skipped.push({
      id: "static-gates",
      reason: "No static check gates were discovered."
    });
  }

  const commandExecutions = await executeStaticCheckGates(context.projectRoot, context.stage.repairPolicy.writesAllowed, plan);
  const commands = commandExecutions.map((execution) => execution.command);
  const changedFiles = changedFilesFromExecutions(commandExecutions);
  const failedCommands = commands.filter((command) => command.status === "failed");
  const status = failedCommands.length > 0 ? "failed" : "success";
  const referencesArtifactPath = path.join(path.dirname(context.stageReportPath), "language-references.json");
  const artifacts = [context.stageReportPath, referencesArtifactPath];

  await writeProjectJson(context.projectRoot, referencesArtifactPath, {
    schema_version: 1,
    stage_id: context.stage.id,
    languages
  });

  const report: StageReport = {
    schema_version: 1,
    run_id: context.runState.id,
    stage_id: context.stage.id,
    status,
    summary: staticCheckSummary(status, commands, plan.skipped, languages),
    commands,
    findings: staticCheckFindings(commandExecutions),
    artifacts,
    skipped: plan.skipped,
    changed_files: changedFiles,
    blockers: []
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

async function executeStaticCheckGates(
  projectRoot: string,
  writesAllowed: boolean,
  plan: StaticCheckPlan
): Promise<CommandExecution[]> {
  const readOnlyGates = plan.gates.filter((gate) => gate.mode === "read-only");
  const writerGates = plan.gates.filter((gate) => gate.mode === "writer");
  const readOnlyParallelGroup = readOnlyGates.length > 1 ? "read-only-1" : undefined;
  const readOnlyExecutions = await Promise.all(
    readOnlyGates.map((gate) => executeReadOnlyGate(projectRoot, gate, readOnlyParallelGroup))
  );

  if (!writesAllowed && writerGates.length > 0) {
    return [
      ...readOnlyExecutions,
      ...writerGates.map((gate): CommandExecution => ({
        gate,
        stdout: "",
        stderr: "",
        changedFiles: [],
        command: {
          name: gate.name,
          command: gate.command,
          status: "skipped",
          reason: "Stage repair policy does not allow workspace writes."
        }
      }))
    ];
  }

  const beforeWriters =
    writerGates.length > 0 ? await snapshotProjectWorkspace(projectRoot) : new Map<string, { hash: string }>();
  const writerExecutions: CommandExecution[] = [];

  for (const gate of writerGates) {
    writerExecutions.push(await executeGate(projectRoot, projectRoot, gate));
  }

  if (writerExecutions.length > 0) {
    const afterWriters = await snapshotProjectWorkspace(projectRoot);
    const changedFiles = diffSnapshots(beforeWriters, afterWriters);
    if (changedFiles.length > 0) {
      writerExecutions[writerExecutions.length - 1].command.summary = appendSummary(
        writerExecutions[writerExecutions.length - 1].command.summary,
        `Changed files: ${changedFiles.join(", ")}.`
      );
    }
    for (const execution of writerExecutions) {
      execution.changedFiles = changedFiles;
    }

    if (changedFiles.length > 0 && readOnlyGates.length > 0) {
      const rerunParallelGroup = readOnlyGates.length > 1 ? "read-only-post-write-1" : undefined;
      const rerunExecutions = await Promise.all(
        readOnlyGates.map((gate) => executeReadOnlyGate(projectRoot, gate, rerunParallelGroup))
      );
      return [...readOnlyExecutions, ...writerExecutions, ...rerunExecutions];
    }
  }

  return [...readOnlyExecutions, ...writerExecutions];
}

async function executeReadOnlyGate(
  projectRoot: string,
  gate: StaticCheckGate,
  parallelGroup?: string
): Promise<CommandExecution> {
  const isolatedRoot = await createIsolatedWorkspace(
    projectRoot,
    "agentmatrix-static-check",
    ISOLATION_COPY_IGNORED_DIRECTORIES
  );

  try {
    return await executeGate(isolatedRoot, projectRoot, gate, parallelGroup);
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true });
  }
}

async function executeGate(
  workingDirectory: string,
  projectRoot: string,
  gate: StaticCheckGate,
  parallelGroup?: string
): Promise<CommandExecution> {
  const startedAt = Date.now();

  if (gate.argv.length === 0) {
    return {
      gate,
      stdout: "",
      stderr: "",
      changedFiles: [],
      command: {
        name: gate.name,
        command: gate.command,
        status: "skipped",
        reason: "No executable argv was provided for this static check gate.",
        ...(parallelGroup ? { parallel_group: parallelGroup } : {})
      }
    };
  }

  const result = await runCommand(gate.argv, workingDirectory, projectRoot);
  const durationMs = Date.now() - startedAt;
  const status = result.exitCode === 0 ? "success" : "failed";

  return {
    gate,
    stdout: result.stdout,
    stderr: result.stderr,
    changedFiles: [],
    command: {
      name: gate.name,
      command: gate.command,
      status,
      exit_code: result.exitCode,
      duration_ms: durationMs,
      summary: commandSummary(status, result.stdout, result.stderr),
      ...(parallelGroup ? { parallel_group: parallelGroup } : {})
    }
  };
}

async function discoverStaticCheckPlan(projectRoot: string): Promise<StaticCheckPlan> {
  const scripts = await readPackageScripts(projectRoot);
  const makeTargets = await readMakeTargets(projectRoot);
  const gates: StaticCheckGate[] = [];
  const skipped: StageReportSkippedItem[] = [];

  const packageScriptCandidates: Array<{
    id: string;
    name: string;
    kind: StaticCheckGateKind;
    scripts: string[];
  }> = [
    { id: "lint", name: "Lint", kind: "lint", scripts: ["lint"] },
    { id: "typecheck", name: "Typecheck", kind: "typecheck", scripts: ["typecheck"] },
    { id: "format-check", name: "Format Check", kind: "formatter", scripts: ["format:check", "check:format"] },
    { id: "security", name: "Security Scan", kind: "security", scripts: ["security", "scan:security", "security:scan"] },
    { id: "dependency", name: "Dependency Scan", kind: "dependency", scripts: ["audit", "deps:audit", "dependency:scan"] }
  ];

  for (const candidate of packageScriptCandidates) {
    const scriptName = candidate.scripts.find((script) => Object.hasOwn(scripts, script));
    if (scriptName) {
      gates.push(packageScriptGate(candidate.id, candidate.name, candidate.kind, scriptName, "read-only"));
      continue;
    }

    const makeTarget = candidate.scripts.find((script) => makeTargets.has(script));
    if (makeTarget) {
      gates.push(makeTargetGate(candidate.id, candidate.name, candidate.kind, makeTarget, "read-only"));
    }
  }

  const writerScriptCandidates: Array<{
    id: string;
    name: string;
    kind: StaticCheckGateKind;
    scripts: string[];
  }> = [
    { id: "lint-fix", name: "Lint Autofix", kind: "lint", scripts: ["lint:fix"] },
    { id: "format", name: "Format", kind: "formatter", scripts: ["format", "format:write", "fix"] }
  ];

  for (const candidate of writerScriptCandidates) {
    const scriptName = candidate.scripts.find((script) => Object.hasOwn(scripts, script));
    if (scriptName) {
      gates.push(packageScriptGate(candidate.id, candidate.name, candidate.kind, scriptName, "writer"));
      continue;
    }

    const makeTarget = candidate.scripts.find((script) => makeTargets.has(script));
    if (makeTarget) {
      gates.push(makeTargetGate(candidate.id, candidate.name, candidate.kind, makeTarget, "writer"));
    }
  }

  return { gates, skipped };
}

function packageScriptGate(
  id: string,
  name: string,
  kind: StaticCheckGateKind,
  scriptName: string,
  mode: StaticCheckGateMode
): StaticCheckGate {
  return {
    id,
    name,
    kind,
    command: `npm run ${scriptName}`,
    argv: ["npm", "run", scriptName],
    mode
  };
}

function makeTargetGate(
  id: string,
  name: string,
  kind: StaticCheckGateKind,
  target: string,
  mode: StaticCheckGateMode
): StaticCheckGate {
  return {
    id,
    name,
    kind,
    command: `make ${target}`,
    argv: ["make", target],
    mode
  };
}

async function listProjectFiles(projectRoot: string) {
  const files: string[] = [];

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WORKSPACE_IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(path.join(directory, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(toProjectRelative(projectRoot, path.join(directory, entry.name)));
      }
    }
  }

  await visit(projectRoot);
  return files.sort();
}

async function snapshotProjectWorkspace(projectRoot: string): Promise<WorkspaceSnapshot> {
  return snapshotWorkspace(projectRoot, WORKSPACE_IGNORED_DIRECTORIES);
}

function changedFilesFromExecutions(executions: CommandExecution[]) {
  const changedFiles = new Set<string>();

  for (const execution of executions) {
    for (const filePath of execution.changedFiles) {
      changedFiles.add(filePath);
    }
  }

  return [...changedFiles].sort();
}

function staticCheckFindings(executions: CommandExecution[]): Record<string, unknown>[] {
  return executions
    .filter((execution) => execution.command.status === "failed")
    .map((execution) => ({
      severity: "blocker",
      source: execution.gate.kind,
      message: execution.command.summary ?? `Static check gate "${execution.gate.id}" failed.`,
      fix_applied: execution.gate.mode === "writer"
    }));
}

function staticCheckSummary(
  status: StageReport["status"],
  commands: StageReportCommand[],
  skipped: StageReportSkippedItem[],
  languages: StaticCheckLanguageReference[]
) {
  if (status === "failed") {
    const failed = commands.filter((command) => command.status === "failed").length;
    return `Static gates failed: ${failed} command${failed === 1 ? "" : "s"} failed.`;
  }

  if (commands.length === 0) {
    return "Static check found no runnable static gates.";
  }

  const languageSummary =
    languages.length > 0 ? ` Selected references: ${languages.map((language) => language.name).join(", ")}.` : "";
  const skippedSummary = skipped.length > 0 ? ` Skipped ${skipped.length} gate${skipped.length === 1 ? "" : "s"}.` : "";
  return `Static gates completed: ${commands.length} command${commands.length === 1 ? "" : "s"} succeeded.${languageSummary}${skippedSummary}`;
}

function commandSummary(status: StageReportCommand["status"], stdout: string, stderr: string) {
  if (status === "success") {
    return firstOutputLine(stdout) ?? "Command completed successfully.";
  }

  return firstOutputLine(stderr) ?? firstOutputLine(stdout) ?? "Command failed.";
}

function firstOutputLine(output: string) {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line;
}

function appendSummary(current: string | undefined, addition: string) {
  return current ? `${current} ${addition}` : addition;
}

function toProjectRelative(projectRoot: string, filePath: string) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}
