import { usesAgentMatrixStaticCheckExecutor } from "./builtin-stage-executors.js";
import { AgentMatrixError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

export type ResourceKind = "agent" | "skill" | "mcp_resource";

export interface RequiredResource {
  kind: ResourceKind;
  id: string;
}

export interface AvailableResources {
  agents: string[];
  skills: string[];
  mcpResources: string[];
}

export interface ResourceProvider {
  hasResource(resource: RequiredResource): boolean | Promise<boolean>;
}

export async function assertWorkflowResourcesAvailable(
  workflow: WorkflowDefinition,
  provider: ResourceProvider
): Promise<void> {
  const missing: RequiredResource[] = [];

  for (const resource of requiredResourcesForWorkflow(workflow)) {
    if (!(await provider.hasResource(resource))) {
      missing.push(resource);
    }
  }

  if (missing.length > 0) {
    throw new AgentMatrixError(formatMissingResources(missing));
  }
}

export function availableResourcesFromWorkflow(workflow: WorkflowDefinition): AvailableResources {
  return {
    agents: unique(
      workflow.stages.flatMap((stage) => [
        ...(usesAgentMatrixStaticCheckExecutor(workflow.id, stage.id) ? [] : [stage.agentRole]),
        stage.verifierRole
      ])
    ),
    skills: unique(workflow.stages.flatMap((stage) => stage.skills)),
    mcpResources: unique(workflow.stages.flatMap((stage) => stage.mcpResources))
  };
}

export function availableResourceProvider(availableResources: AvailableResources): ResourceProvider {
  const available = {
    agent: new Set(availableResources.agents),
    skill: new Set(availableResources.skills),
    mcp_resource: new Set(availableResources.mcpResources)
  };

  return {
    hasResource(resource) {
      return available[resource.kind].has(resource.id);
    }
  };
}

export function normalizeAvailableResources(value: unknown): AvailableResources {
  if (!isRecord(value)) {
    return { agents: [], skills: [], mcpResources: [] };
  }

  return {
    agents: readStringArray(value.agents),
    skills: readStringArray(value.skills),
    mcpResources: readStringArray(value.mcpResources)
  };
}

export function mergeAvailableResources(
  existing: AvailableResources,
  required: AvailableResources
): AvailableResources {
  return {
    agents: unique([...existing.agents, ...required.agents]),
    skills: unique([...existing.skills, ...required.skills]),
    mcpResources: unique([...existing.mcpResources, ...required.mcpResources])
  };
}

function requiredResourcesForWorkflow(workflow: WorkflowDefinition): RequiredResource[] {
  const resources: RequiredResource[] = [];

  for (const stage of workflow.stages) {
    if (!usesAgentMatrixStaticCheckExecutor(workflow.id, stage.id)) {
      resources.push({ kind: "agent", id: stage.agentRole });
    }
    resources.push({ kind: "agent", id: stage.verifierRole });
    resources.push(...stage.skills.map((id) => ({ kind: "skill" as const, id })));
    resources.push(...stage.mcpResources.map((id) => ({ kind: "mcp_resource" as const, id })));
  }

  return uniqueResources(resources);
}

function formatMissingResources(missing: RequiredResource[]) {
  return [
    "Missing required resources before workflow execution:",
    ...missing.map((resource) => `- ${resource.kind}: ${resource.id}`),
    "Use the existing agent, skill, or MCP installer to install or expose the missing resources, then update the AgentMatrix resource provider."
  ].join("\n");
}

function uniqueResources(resources: RequiredResource[]) {
  const seen = new Set<string>();
  const result: RequiredResource[] = [];

  for (const resource of resources) {
    const key = `${resource.kind}:${resource.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resource);
    }
  }

  return result;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
