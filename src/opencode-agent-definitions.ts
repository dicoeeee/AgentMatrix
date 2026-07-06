import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { usesAgentMatrixStaticCheckExecutor } from "./builtin-stage-executors.js";
import { AgentMatrixError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

interface MissingOpencodeAgentDefinition {
  role: string;
  checkedLocations: string[];
}

export async function assertOpencodeAgentDefinitionsAvailable(
  projectRoot: string,
  workflow: WorkflowDefinition
): Promise<void> {
  let opencodeJson: unknown;
  let opencodeJsonLoaded = false;
  const missing: MissingOpencodeAgentDefinition[] = [];

  for (const role of opencodeAgentRoles(workflow)) {
    const markdownLocation = opencodeAgentMarkdownLocation(role);
    const jsonLocation = opencodeJsonAgentLocation(role);

    if (await isFile(path.join(projectRoot, markdownLocation))) {
      continue;
    }

    if (!opencodeJsonLoaded) {
      opencodeJson = await readOpencodeJson(projectRoot);
      opencodeJsonLoaded = true;
    }
    if (hasOpencodeJsonAgent(opencodeJson, role)) {
      continue;
    }

    missing.push({
      role,
      checkedLocations: [markdownLocation, jsonLocation]
    });
  }

  if (missing.length > 0) {
    throw new AgentMatrixError(formatMissingOpencodeAgentDefinitions(missing));
  }
}

function opencodeAgentRoles(workflow: WorkflowDefinition) {
  return [
    ...new Set(
      workflow.stages.flatMap((stage) => [
        ...(usesAgentMatrixStaticCheckExecutor(workflow.id, stage.id) ? [] : [stage.agentRole]),
        stage.verifierRole
      ])
    )
  ];
}

function opencodeAgentMarkdownLocation(role: string) {
  return `.opencode/agents/${role}.md`;
}

function opencodeJsonAgentLocation(role: string) {
  return `opencode.json agent.${role}`;
}

async function readOpencodeJson(projectRoot: string): Promise<unknown> {
  const configPath = path.join(projectRoot, "opencode.json");

  if (!(await pathExists(configPath))) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return undefined;
  }
}

function hasOpencodeJsonAgent(config: unknown, role: string) {
  if (!isRecord(config) || !isRecord(config.agent)) {
    return false;
  }

  return isRecord(config.agent[role]);
}

function formatMissingOpencodeAgentDefinitions(missing: MissingOpencodeAgentDefinition[]) {
  return [
    "Missing OpenCode agent definitions before workflow execution:",
    ...missing.flatMap((agent) => [
      `- agent: ${agent.role}`,
      ...agent.checkedLocations.map((location) => `  checked: ${location}`)
    ]),
    "Run `agentmatrix init --platform opencode` to install project-local OpenCode agent templates, or add matching entries to opencode.json."
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function isFile(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
