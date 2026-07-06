#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentMatrixError, CliUsageError } from "./errors.js";
import { createMockRuntimeAdapter } from "./mock-runtime.js";
import {
  createOpencodeRuntimeAdapter,
  type OpencodeCommandEvent,
  type OpencodeRuntimeOptions
} from "./opencode-runtime.js";
import type { PlatformKind } from "./opencode-platform.js";
import {
  createRun,
  initializeProject,
  readRunForDisplay,
  readRuns,
  readWorkflowForDisplay,
  resumeRun
} from "./storage.js";
import { BUILT_IN_WORKFLOW_IDS, DEFAULT_WORKFLOW_ID, isBuiltInWorkflowId } from "./templates.js";
import { AGENTMATRIX_DIR, type RunState, type StageFailureMetadata } from "./types.js";
import { runToGraph, runToMermaid, workflowToGraph, workflowToMermaid } from "./visualize.js";

interface CliIo {
  stdout: { write(message: string): void };
  stderr: { write(message: string): void };
}

interface GlobalParseResult {
  projectRoot: string;
  args: string[];
}

type VisualizationFormat = "mermaid" | "json";
type RuntimeKind = "mock" | "opencode";
type VisualizationTarget =
  | {
      kind: "run";
      runId?: string;
    }
  | {
      kind: "workflow";
      workflowId: string;
    };

const HELP = `AgentMatrix

Usage:
  agentmatrix [--project <dir>] <command> [options]

Commands:
  init                 Create the project-local AgentMatrix skeleton
  run [workflow]        Start a fresh workflow run
  resume [run-id]       Continue an existing run
  status [--json]       Show current and past run states
  visualize [run-id]    Render a workflow or run as Mermaid or JSON

Global options:
  --project <dir>       Use a project directory other than the current directory
  -h, --help            Show help

Exit codes:
  0  Success or help
  1  Runtime error
  2  Command line usage error
`;

const COMMAND_HELP: Record<string, string> = {
  init: `agentmatrix init

Create the project-local AgentMatrix skeleton under .agentmatrix/.

Usage:
  agentmatrix [--project <dir>] init [--workflow mr-preflight] [--platform opencode] [--force]

Options:
  --workflow <workflow>  Built-in workflow template to install: mr-preflight
  --platform opencode   Also install OpenCode agent templates for the workflow roles
  --force               Overwrite existing OpenCode agent templates; config and workflow files are still preserved
`,
  run: `agentmatrix run

Start a fresh workflow run and write project-local filesystem state.

Usage:
  agentmatrix [--project <dir>] run [workflow] [--runtime mock|opencode] [--verbose]

Runtime options:
  --runtime <runtime>       Runtime adapter to use: mock or opencode
  --verbose                 Print runtime command details
  --opencode-bin <path>     OpenCode executable path when using --runtime opencode
  --opencode-model <model>  OpenCode model in provider/model form
  --opencode-attach <url>   Attach to a running opencode serve instance
  --opencode-auto           Pass --auto to opencode run
`,
  resume: `agentmatrix resume

Continue an existing run by id, or the latest resumable run when no id is provided.

Usage:
  agentmatrix [--project <dir>] resume [run-id] [--runtime mock|opencode] [--verbose]

Runtime options:
  --runtime <runtime>       Runtime adapter to use: mock or opencode
  --verbose                 Print runtime command details
  --opencode-bin <path>     OpenCode executable path when using --runtime opencode
  --opencode-model <model>  OpenCode model in provider/model form
  --opencode-attach <url>   Attach to a running opencode serve instance
  --opencode-auto           Pass --auto to opencode run
`,
  status: `agentmatrix status

Show current and past run states.

Usage:
  agentmatrix [--project <dir>] status [--json]
`,
  visualize: `agentmatrix visualize

Render a workflow definition or run graph as Mermaid or JSON.

Usage:
  agentmatrix [--project <dir>] visualize [run-id] [--format mermaid|json]
  agentmatrix [--project <dir>] visualize --workflow mr-preflight [--format mermaid|json]
`
};

export async function runCli(argv: string[], io: CliIo = process): Promise<number> {
  try {
    const { projectRoot, args } = parseGlobalOptions(argv);

    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
      io.stdout.write(HELP);
      return 0;
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      const help = COMMAND_HELP[command];
      if (!help) {
        throw new CliUsageError(`Unknown command "${command}". Run \`agentmatrix --help\` for usage.`);
      }
      io.stdout.write(help);
      return 0;
    }

    switch (command) {
      case "init":
        await handleInit(projectRoot, commandArgs, io);
        return 0;
      case "run":
        await handleRun(projectRoot, commandArgs, io);
        return 0;
      case "resume":
        await handleResume(projectRoot, commandArgs, io);
        return 0;
      case "status":
        await handleStatus(projectRoot, commandArgs, io);
        return 0;
      case "visualize":
        await handleVisualize(projectRoot, commandArgs, io);
        return 0;
      default:
        throw new CliUsageError(`Unknown command "${command}". Run \`agentmatrix --help\` for usage.`);
    }
  } catch (error) {
    const normalized = normalizeError(error);
    io.stderr.write(`${normalized.message}\n`);
    return normalized.exitCode;
  }
}

async function handleInit(projectRoot: string, args: string[], io: CliIo) {
  const { workflowId, platform, force } = parseInitArgs(args);
  const result = await initializeProject(projectRoot, workflowId, {
    platform,
    forcePlatformTemplates: force
  });
  const action = result.workflowCreated ? "created" : "already present";
  io.stdout.write(`Initialized AgentMatrix in ${result.projectRoot}\n`);
  io.stdout.write(`Workflow ${action}: ${path.relative(result.projectRoot, result.workflowPath)}\n`);
  io.stdout.write(
    `Skill templates: created ${result.skillTemplates.created.length}, skipped ${result.skillTemplates.skipped.length}\n`
  );
  if (result.skillTemplates.unavailable.length > 0) {
    io.stdout.write(`Skill templates unavailable: ${result.skillTemplates.unavailable.join(", ")}\n`);
  }
  if (result.platformTemplates) {
    io.stdout.write(
      `OpenCode agent templates: created ${result.platformTemplates.created.length}, skipped ${result.platformTemplates.skipped.length}\n`
    );
  }
}

async function handleRun(projectRoot: string, args: string[], io: CliIo) {
  const { positional: workflowId, runtimeAdapter } = parseExecutionArgs(args, "run", "workflow", io);
  const runState = await createRun(projectRoot, workflowId, { runtimeAdapter });
  io.stdout.write(`Created run ${runState.id} for workflow ${runState.workflowId}\n`);
  io.stdout.write(`State: ${AGENTMATRIX_DIR}/runs/${runState.id}/run.json\n`);
  if (runState.status === "success") {
    io.stdout.write(`Completed run ${runState.id}\n`);
  }
}

async function handleResume(projectRoot: string, args: string[], io: CliIo) {
  const { positional: runId, runtimeAdapter } = parseExecutionArgs(args, "resume", "run-id", io);
  const runState = await resumeRun(projectRoot, runId, { runtimeAdapter });
  io.stdout.write(`Resumed run ${runState.id}\n`);
  if (runState.status === "success") {
    io.stdout.write(`Completed run ${runState.id}\n`);
  }
}

async function handleStatus(projectRoot: string, args: string[], io: CliIo) {
  const { asJson } = parseStatusArgs(args);
  const runs = await readRuns(projectRoot);

  if (asJson) {
    io.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    return;
  }

  if (runs.length === 0) {
    io.stdout.write("No AgentMatrix runs found.\n");
    return;
  }

  io.stdout.write(formatRuns(runs));
}

async function handleVisualize(projectRoot: string, args: string[], io: CliIo) {
  const { target, format } = parseVisualizeArgs(args);

  if (target.kind === "workflow") {
    const workflow = await readWorkflowForDisplay(projectRoot, target.workflowId);
    if (format === "json") {
      io.stdout.write(`${JSON.stringify(workflowToGraph(workflow), null, 2)}\n`);
      return;
    }

    io.stdout.write(workflowToMermaid(workflow));
    return;
  }

  const runState = await readRunForDisplay(projectRoot, target.runId);

  if (format === "json") {
    io.stdout.write(`${JSON.stringify(runToGraph(runState), null, 2)}\n`);
    return;
  }

  io.stdout.write(runToMermaid(runState));
}

function parseGlobalOptions(argv: string[]): GlobalParseResult {
  const args: string[] = [];
  let projectRoot = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--project") {
      const value = argv[index + 1];
      if (!value) {
        throw new CliUsageError("Missing value for --project.");
      }
      projectRoot = path.resolve(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--project=")) {
      const value = token.slice("--project=".length);
      if (!value) {
        throw new CliUsageError("Missing value for --project.");
      }
      projectRoot = path.resolve(value);
      continue;
    }

    args.push(token);
  }

  return { projectRoot, args };
}

function parseInitArgs(args: string[]) {
  let workflowId = DEFAULT_WORKFLOW_ID;
  let platform: PlatformKind | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--workflow") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("Missing value for --workflow.");
      }
      workflowId = parseWorkflowTemplate(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--workflow=")) {
      workflowId = parseWorkflowTemplate(token.slice("--workflow=".length));
      continue;
    }

    if (token === "--platform") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("Missing value for --platform.");
      }
      platform = parsePlatform(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--platform=")) {
      platform = parsePlatform(token.slice("--platform=".length));
      continue;
    }

    if (token === "--force") {
      force = true;
      continue;
    }

    rejectOptionToken(token, "init");
    rejectUnexpectedPositional(token, "init");
  }

  if (force && !platform) {
    throw new CliUsageError("--force requires --platform opencode.");
  }

  return { workflowId, platform, force };
}

function parseWorkflowTemplate(value: string) {
  if (isBuiltInWorkflowId(value)) {
    return value;
  }

  throw new CliUsageError(
    `Unknown workflow template "${value}". Built-in workflows: ${BUILT_IN_WORKFLOW_IDS.join(", ")}.`
  );
}

function parsePlatform(value: string): PlatformKind {
  if (value === "opencode") {
    return value;
  }

  throw new CliUsageError('Platform must be "opencode".');
}

function parseOptionalPositional(args: string[], command: string, name: string) {
  rejectUnknownOptions(args, command);

  if (args.length > 1) {
    throw new CliUsageError(`Command "${command}" accepts at most one ${name}.`);
  }

  return args[0];
}

function parseExecutionArgs(args: string[], command: string, name: string, io: CliIo) {
  let runtime: RuntimeKind = "mock";
  const opencodeOptions: OpencodeRuntimeOptions = {};
  const positionals: string[] = [];
  let sawOpencodeOption = false;
  let verbose = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--runtime") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("Missing value for --runtime.");
      }
      runtime = parseRuntime(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--runtime=")) {
      runtime = parseRuntime(token.slice("--runtime=".length));
      continue;
    }

    if (token === "--opencode-bin") {
      opencodeOptions.executable = readOptionValue(args, index, "--opencode-bin");
      sawOpencodeOption = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--opencode-bin=")) {
      opencodeOptions.executable = readInlineOptionValue(token, "--opencode-bin");
      sawOpencodeOption = true;
      continue;
    }

    if (token === "--opencode-model") {
      opencodeOptions.model = readOptionValue(args, index, "--opencode-model");
      sawOpencodeOption = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--opencode-model=")) {
      opencodeOptions.model = readInlineOptionValue(token, "--opencode-model");
      sawOpencodeOption = true;
      continue;
    }

    if (token === "--opencode-attach") {
      opencodeOptions.attach = readOptionValue(args, index, "--opencode-attach");
      sawOpencodeOption = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--opencode-attach=")) {
      opencodeOptions.attach = readInlineOptionValue(token, "--opencode-attach");
      sawOpencodeOption = true;
      continue;
    }

    if (token === "--opencode-auto") {
      opencodeOptions.autoApprove = true;
      sawOpencodeOption = true;
      continue;
    }

    if (token === "--verbose") {
      verbose = true;
      continue;
    }

    rejectOptionToken(token, command);
    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliUsageError(`Command "${command}" accepts at most one ${name}.`);
  }

  if (runtime !== "opencode" && sawOpencodeOption) {
    throw new CliUsageError("OpenCode options require --runtime opencode.");
  }

  if (verbose) {
    opencodeOptions.onCommandResult = (event) => {
      io.stdout.write(formatOpencodeVerboseEvent(event));
    };
  }

  return {
    positional: positionals[0],
    runtimeAdapter:
      runtime === "opencode" ? createOpencodeRuntimeAdapter(opencodeOptions) : createMockRuntimeAdapter()
  };
}

function formatOpencodeVerboseEvent(event: OpencodeCommandEvent) {
  const lines = [
    `[opencode:${event.kind}] stage=${event.stageId} agent=${event.agentRole} exit=${event.exitCode}`,
    `command: ${event.command}`
  ];

  if (event.stdout.trim().length > 0) {
    lines.push("stdout:", trimTrailingWhitespace(event.stdout));
  }
  if (event.stderr.trim().length > 0) {
    lines.push("stderr:", trimTrailingWhitespace(event.stderr));
  }

  return `${lines.join("\n")}\n`;
}

function parseStatusArgs(args: string[]) {
  let asJson = false;

  for (const token of args) {
    if (token === "--json") {
      asJson = true;
      continue;
    }
    rejectOptionToken(token, "status");
    rejectUnexpectedPositional(token, "status");
  }

  return { asJson };
}

function parseVisualizeArgs(args: string[]) {
  let format: VisualizationFormat = "mermaid";
  let workflowId: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--format") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("Missing value for --format.");
      }
      format = parseFormat(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--format=")) {
      format = parseFormat(token.slice("--format=".length));
      continue;
    }

    if (token === "--workflow") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("Missing value for --workflow.");
      }
      workflowId = parseWorkflowTemplate(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--workflow=")) {
      const value = token.slice("--workflow=".length);
      if (!value) {
        throw new CliUsageError("Missing value for --workflow.");
      }
      workflowId = parseWorkflowTemplate(value);
      continue;
    }

    rejectOptionToken(token, "visualize");

    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliUsageError('Command "visualize" accepts at most one run-id.');
  }

  if (workflowId && positionals.length > 0) {
    throw new CliUsageError('Command "visualize" cannot combine --workflow with a run-id.');
  }

  return {
    target: workflowId
      ? {
          kind: "workflow" as const,
          workflowId
        }
      : {
          kind: "run" as const,
          runId: positionals[0]
        },
    format
  };
}

function parseFormat(value: string): VisualizationFormat {
  if (value === "mermaid" || value === "json") {
    return value;
  }
  throw new CliUsageError('Visualization format must be "mermaid" or "json".');
}

function parseRuntime(value: string): RuntimeKind {
  if (value === "mock" || value === "opencode") {
    return value;
  }
  throw new CliUsageError('Runtime must be "mock" or "opencode".');
}

function readOptionValue(args: string[], index: number, optionName: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${optionName}.`);
  }
  return value;
}

function readInlineOptionValue(token: string, optionName: string) {
  const value = token.slice(`${optionName}=`.length);
  if (!value) {
    throw new CliUsageError(`Missing value for ${optionName}.`);
  }
  return value;
}

function trimTrailingWhitespace(value: string) {
  return value.replace(/\s+$/u, "");
}

function rejectUnknownOptions(args: string[], command: string) {
  for (const token of args) {
    rejectOptionToken(token, command);
  }
}

function rejectOptionToken(token: string, command: string) {
  if (token.startsWith("-")) {
    throw new CliUsageError(`Unknown option "${token}" for command "${command}".`);
  }
}

function rejectUnexpectedPositional(token: string, command: string) {
  throw new CliUsageError(`Command "${command}" does not accept positional argument "${token}".`);
}

function formatRuns(runs: RunState[]) {
  const rows = [
    ["Run ID", "Workflow", "Status", "Stages", "Failure", "Updated"],
    ...runs.map((run) => [
      run.id,
      run.workflowId,
      run.status,
      formatStageStatuses(run),
      formatRunFailure(run),
      run.updatedAt
    ])
  ];
  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length))
  );

  return `${rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ")).join("\n")}\n`;
}

function formatStageStatuses(run: RunState) {
  return run.stages.map((stage) => `${stage.id}=${stage.status}`).join(", ");
}

function formatRunFailure(run: RunState) {
  const failedStage = run.stages.find((stage) => stage.failure);
  if (!failedStage?.failure) {
    return "";
  }

  return `${failedStage.id} ${formatFailure(failedStage.failure)}`;
}

function formatFailure(failure: StageFailureMetadata) {
  const metadata = formatFailureMetadata(failure.metadata);
  return `${failure.kind}: ${failure.message}${metadata ? ` (${metadata})` : ""}`;
}

function formatFailureMetadata(metadata: StageFailureMetadata["metadata"]) {
  if (!metadata) {
    return "";
  }

  return Object.entries(metadata)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

function normalizeError(error: unknown) {
  if (error instanceof AgentMatrixError) {
    return error;
  }

  if (error instanceof Error) {
    return new AgentMatrixError(error.message);
  }

  return new AgentMatrixError(String(error));
}

function isCliEntrypoint(argvPath: string) {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return import.meta.url === pathToFileURL(argvPath).href;
  }
}

if (process.argv[1] && isCliEntrypoint(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
