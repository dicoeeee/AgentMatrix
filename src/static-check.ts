import { createHash } from "node:crypto";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeProjectJson } from "./project-files.js";
import type { StageReport, StageReportCommand, StageReportSkippedItem } from "./stage-report.js";
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

interface StaticCheckLanguage {
  id: string;
  name: string;
  reference: string;
  matches: string[];
}

interface LanguageDefinition {
  id: string;
  name: string;
  reference: string;
  matches(relativePath: string): boolean;
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

interface WorkspaceSnapshotEntry {
  hash: string;
  content: Buffer;
}

type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_BUFFER = 10 * 1024 * 1024;
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

const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  {
    id: "c",
    name: "C",
    reference: "static-check/references/c.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".c", ".h"]) || basenameEquals(relativePath, "compile_commands.json")
  },
  {
    id: "cpp",
    name: "C++",
    reference: "static-check/references/cpp.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"]) ||
      basenameEquals(relativePath, "compile_commands.json")
  },
  {
    id: "java",
    name: "Java",
    reference: "static-check/references/java.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".java"]) ||
      basenameEquals(relativePath, "pom.xml") ||
      basenameEquals(relativePath, "build.gradle") ||
      basenameEquals(relativePath, "build.gradle.kts") ||
      basenameEquals(relativePath, "settings.gradle") ||
      basenameEquals(relativePath, "settings.gradle.kts")
  },
  {
    id: "go",
    name: "Go",
    reference: "static-check/references/go.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".go"]) ||
      basenameEquals(relativePath, "go.mod") ||
      basenameEquals(relativePath, "go.work")
  },
  {
    id: "rust",
    name: "Rust",
    reference: "static-check/references/rust.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".rs"]) ||
      basenameEquals(relativePath, "Cargo.toml") ||
      basenameEquals(relativePath, "Cargo.lock")
  },
  {
    id: "javascript",
    name: "JavaScript",
    reference: "static-check/references/javascript.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".js", ".mjs", ".cjs", ".jsx"]) ||
      basenameEquals(relativePath, "package.json") ||
      basenameEquals(relativePath, "package-lock.json") ||
      basenameEquals(relativePath, "yarn.lock") ||
      basenameEquals(relativePath, "pnpm-lock.yaml")
  },
  {
    id: "typescript",
    name: "TypeScript",
    reference: "static-check/references/typescript.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".ts", ".tsx", ".mts", ".cts"]) ||
      (basenameStartsWith(relativePath, "tsconfig") && hasExtension(relativePath, [".json"]))
  },
  {
    id: "python",
    name: "Python",
    reference: "static-check/references/python.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".py"]) ||
      basenameEquals(relativePath, "pyproject.toml") ||
      basenameEquals(relativePath, "setup.cfg") ||
      basenameEquals(relativePath, "poetry.lock") ||
      basenameEquals(relativePath, "uv.lock") ||
      (basenameStartsWith(relativePath, "requirements") && hasExtension(relativePath, [".txt"]))
  },
  {
    id: "shell",
    name: "Shell",
    reference: "static-check/references/shell.md",
    matches: (relativePath) =>
      hasExtension(relativePath, [".sh", ".bash", ".zsh", ".ksh"]) ||
      basenameEquals(relativePath, "Makefile")
  }
];

export async function executeStaticCheckStage(
  context: StageExecutionContext,
  options: StaticCheckOptions = {}
): Promise<StageExecutionResult> {
  const projectFiles = await listProjectFiles(context.projectRoot);
  const languages = selectLanguageReferences(projectFiles);
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
    writerGates.length > 0 ? await snapshotWorkspace(projectRoot) : new Map<string, WorkspaceSnapshotEntry>();
  const writerExecutions: CommandExecution[] = [];

  for (const gate of writerGates) {
    writerExecutions.push(await executeGate(projectRoot, projectRoot, gate));
  }

  if (writerExecutions.length > 0) {
    const afterWriters = await snapshotWorkspace(projectRoot);
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
  const isolatedRoot = await createIsolatedWorkspace(projectRoot);

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

async function runCommand(argv: string[], cwd: string, projectRoot: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  const [executable, ...args] = argv;

  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env: {
          ...process.env,
          CI: process.env.CI ?? "true",
          PATH: commandPath(projectRoot)
        }
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        resolve({
          exitCode: exitCodeFromError(error),
          stdout: stringifyOutput(stdout),
          stderr: stringifyOutput(stderr || error?.message || "")
        });
      }
    );
  });
}

async function createIsolatedWorkspace(projectRoot: string) {
  const isolatedRoot = path.join(
    tmpdir(),
    `agentmatrix-static-check-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(isolatedRoot, { recursive: true });
  await copyWorkspace(projectRoot, isolatedRoot);
  return isolatedRoot;
}

async function copyWorkspace(sourceRoot: string, targetRoot: string, currentDirectory = sourceRoot) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ISOLATION_COPY_IGNORED_DIRECTORIES.has(entry.name)) {
        await copyWorkspace(sourceRoot, targetRoot, path.join(currentDirectory, entry.name));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = path.join(currentDirectory, entry.name);
    const targetPath = path.join(targetRoot, path.relative(sourceRoot, sourcePath));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
  }
}

function commandPath(projectRoot: string) {
  return [path.join(projectRoot, "node_modules", ".bin"), process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
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

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as unknown;
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(packageJson.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

async function readMakeTargets(projectRoot: string): Promise<Set<string>> {
  for (const fileName of ["Makefile", "makefile", "GNUmakefile"]) {
    try {
      return parseMakeTargets(await readFile(path.join(projectRoot, fileName), "utf8"));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  return new Set();
}

function parseMakeTargets(source: string) {
  const targets = new Set<string>();
  const targetPattern = /^([A-Za-z0-9_.-]+)\s*:(?![=])/gm;
  let match: RegExpExecArray | null;

  while ((match = targetPattern.exec(source))) {
    targets.add(match[1]);
  }

  return targets;
}

function selectLanguageReferences(projectFiles: string[]): StaticCheckLanguage[] {
  return LANGUAGE_DEFINITIONS.flatMap((definition) => {
    const matches = projectFiles.filter((relativePath) => definition.matches(relativePath));
    if (matches.length === 0) {
      return [];
    }

    return [
      {
        id: definition.id,
        name: definition.name,
        reference: definition.reference,
        matches: matches.slice(0, 25)
      }
    ];
  });
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

async function snapshotWorkspace(projectRoot: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();

  for (const relativePath of await listProjectFiles(projectRoot)) {
    const filePath = path.join(projectRoot, relativePath);
    const content = await readFile(filePath);
    snapshot.set(relativePath, {
      hash: createHash("sha256").update(content).digest("hex"),
      content
    });
  }

  return snapshot;
}

function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((relativePath) => before.get(relativePath)?.hash !== after.get(relativePath)?.hash).sort();
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
  languages: StaticCheckLanguage[]
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

function exitCodeFromError(error: ExecFileException | null) {
  if (!error) {
    return 0;
  }

  return typeof error.code === "number" ? error.code : 1;
}

function stringifyOutput(output: string | Buffer) {
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function hasExtension(relativePath: string, extensions: string[]) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extensions.includes(extension);
}

function basenameEquals(relativePath: string, basename: string) {
  return path.posix.basename(relativePath) === basename;
}

function basenameStartsWith(relativePath: string, prefix: string) {
  return path.posix.basename(relativePath).startsWith(prefix);
}

function toProjectRelative(projectRoot: string, filePath: string) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
