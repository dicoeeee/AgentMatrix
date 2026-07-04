#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AgentMatrixError, CliUsageError } from "./errors.js";
import { createRun, initializeProject, readRunForDisplay, readRuns, resumeRun } from "./storage.js";
import { BUILT_IN_WORKFLOW_IDS, DEFAULT_WORKFLOW_ID, isBuiltInWorkflowId } from "./templates.js";
import { AGENTMATRIX_DIR } from "./types.js";
import { runToGraph, runToMermaid } from "./visualize.js";

interface CliIo {
  stdout: { write(message: string): void };
  stderr: { write(message: string): void };
}

interface GlobalParseResult {
  projectRoot: string;
  args: string[];
}

type VisualizationFormat = "mermaid" | "json";

const HELP = `AgentMatrix

Usage:
  agentmatrix [--project <dir>] <command> [options]

Commands:
  init                 Create the project-local AgentMatrix skeleton
  run [workflow]        Start a fresh workflow run
  resume [run-id]       Continue an existing run
  status [--json]       Show current and past run states
  visualize [run-id]    Render a run as Mermaid or JSON

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
  agentmatrix [--project <dir>] init [--workflow mr-preflight]
`,
  run: `agentmatrix run

Start a fresh workflow run and write project-local filesystem state.

Usage:
  agentmatrix [--project <dir>] run [workflow]
`,
  resume: `agentmatrix resume

Continue an existing run by id, or the latest resumable run when no id is provided.

Usage:
  agentmatrix [--project <dir>] resume [run-id]
`,
  status: `agentmatrix status

Show current and past run states.

Usage:
  agentmatrix [--project <dir>] status [--json]
`,
  visualize: `agentmatrix visualize

Render a run graph as Mermaid or JSON.

Usage:
  agentmatrix [--project <dir>] visualize [run-id] [--format mermaid|json]
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
  const { workflowId } = parseInitArgs(args);
  const result = await initializeProject(projectRoot, workflowId);
  const action = result.workflowCreated ? "created" : "already present";
  io.stdout.write(`Initialized AgentMatrix in ${result.projectRoot}\n`);
  io.stdout.write(`Workflow ${action}: ${path.relative(result.projectRoot, result.workflowPath)}\n`);
}

async function handleRun(projectRoot: string, args: string[], io: CliIo) {
  const workflowId = parseOptionalPositional(args, "run", "workflow");
  const runState = await createRun(projectRoot, workflowId);
  io.stdout.write(`Created run ${runState.id} for workflow ${runState.workflowId}\n`);
  io.stdout.write(`State: ${AGENTMATRIX_DIR}/runs/${runState.id}/run.json\n`);
}

async function handleResume(projectRoot: string, args: string[], io: CliIo) {
  const runId = parseOptionalPositional(args, "resume", "run-id");
  const runState = await resumeRun(projectRoot, runId);
  io.stdout.write(`Resumed run ${runState.id}\n`);
  io.stdout.write("Execution adapters are not implemented in this foundation slice.\n");
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
  const { runId, format } = parseVisualizeArgs(args);
  const runState = await readRunForDisplay(projectRoot, runId);

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

    rejectOptionToken(token, "init");
    rejectUnexpectedPositional(token, "init");
  }

  return { workflowId };
}

function parseWorkflowTemplate(value: string) {
  if (isBuiltInWorkflowId(value)) {
    return value;
  }

  throw new CliUsageError(
    `Unknown workflow template "${value}". Built-in workflows: ${BUILT_IN_WORKFLOW_IDS.join(", ")}.`
  );
}

function parseOptionalPositional(args: string[], command: string, name: string) {
  rejectUnknownOptions(args, command);

  if (args.length > 1) {
    throw new CliUsageError(`Command "${command}" accepts at most one ${name}.`);
  }

  return args[0];
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

    rejectOptionToken(token, "visualize");

    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliUsageError('Command "visualize" accepts at most one run-id.');
  }

  return {
    runId: positionals[0],
    format
  };
}

function parseFormat(value: string): VisualizationFormat {
  if (value === "mermaid" || value === "json") {
    return value;
  }
  throw new CliUsageError('Visualization format must be "mermaid" or "json".');
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

function formatRuns(runs: Awaited<ReturnType<typeof readRuns>>) {
  const rows = [
    ["Run ID", "Workflow", "Status", "Updated"],
    ...runs.map((run) => [run.id, run.workflowId, run.status, run.updatedAt])
  ];
  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length))
  );

  return `${rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ")).join("\n")}\n`;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
