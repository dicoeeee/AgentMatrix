import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkflowDefinition, WorkflowStage } from "./types.js";
import { workflowSkillTemplateRelativePath } from "./workflow-resource-templates.js";

export type PlatformKind = "opencode";

export interface PlatformTemplateInstallResult {
  created: string[];
  skipped: string[];
}

export interface PlatformTemplateInstallOptions {
  force?: boolean;
}

type AgentTemplateKind = "driver" | "executor" | "verifier";

interface AgentTemplateSpec {
  role: string;
  kind: AgentTemplateKind;
  stage?: WorkflowStage;
}

export async function installOpencodeAgentTemplates(
  projectRoot: string,
  workflow: WorkflowDefinition,
  options: PlatformTemplateInstallOptions = {}
): Promise<PlatformTemplateInstallResult> {
  const agentsDir = path.join(projectRoot, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });

  const result: PlatformTemplateInstallResult = {
    created: [],
    skipped: []
  };

  for (const spec of opencodeAgentTemplateSpecs(workflow)) {
    const relativePath = path.join(".opencode", "agents", `${spec.role}.md`);
    const filePath = path.join(projectRoot, relativePath);

    try {
      await writeFile(filePath, opencodeAgentTemplate(spec), {
        flag: options.force ? "w" : "wx"
      });
      result.created.push(relativePath);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        result.skipped.push(relativePath);
        continue;
      }
      throw error;
    }
  }

  return result;
}

function opencodeAgentTemplateSpecs(workflow: WorkflowDefinition): AgentTemplateSpec[] {
  return [
    {
      role: "agentmatrix_driver",
      kind: "driver" as const
    },
    ...workflow.stages.flatMap((stage) => [
      {
        role: stage.agentRole,
        kind: "executor" as const,
        stage
      },
      {
        role: stage.verifierRole,
        kind: "verifier" as const,
        stage
      }
    ])
  ];
}

function opencodeAgentTemplate(spec: AgentTemplateSpec) {
  if (spec.kind === "driver") {
    return driverTemplate();
  }

  if (!spec.stage) {
    throw new Error(`OpenCode ${spec.kind} template for ${spec.role} is missing a workflow stage.`);
  }

  const canRunShell = spec.kind === "executor";
  const title = spec.kind === "executor" ? "Executor" : "Verifier";
  const description =
    spec.kind === "executor"
      ? `AgentMatrix executor for ${spec.stage.id}`
      : `AgentMatrix verifier for ${spec.stage.id}`;

  return [
    "---",
    `description: "${description}"`,
    "mode: subagent",
    "tools:",
    "  read: true",
    "  write: true",
    `  bash: ${canRunShell ? "true" : "false"}`,
    "---",
    "",
    `# AgentMatrix ${spec.stage.id} ${title}`,
    "",
    `You are the ${spec.kind} role \`${spec.role}\` for the AgentMatrix \`${spec.stage.id}\` stage.`,
    "",
    "Follow the AgentMatrix prompt passed by the runtime. The prompt contains an",
    "`AGENTMATRIX_CONTEXT_JSON` block with the run id, stage contract, output paths,",
    "completion criteria, skills, MCP resources, and evidence path for this invocation.",
    "",
    ...(spec.kind === "executor"
      ? executorInstructions(spec.stage)
      : verifierInstructions(spec)),
    "",
    "Do not create or submit an MR/PR, push branches, assign reviewers, change labels, or watch CI.",
    "If blocked, write the required AgentMatrix evidence/output contract instead of only explaining the blocker.",
    ""
  ].join("\n");
}

function executorInstructions(stage: WorkflowStage) {
  const instructions = [
    "Write every required stage output declared in the context before finishing.",
    "The `stage_report` output must be valid JSON matching AgentMatrix's stage_report schema.",
    `Stage skills exposed by the workflow: ${formatSkillList(stage.skills)}.`,
    `Stage MCP resources exposed by the workflow: ${formatInlineList(stage.mcpResources)}.`
  ];

  if (stage.id === "static_check") {
    instructions.push(
      "For static_check, use `.agentmatrix/skills/static-check/SKILL.md`, focus on the Driver Protocol Change Scope, and limit repairs to safe mechanical repairs."
    );
  }

  return instructions;
}

function verifierInstructions(spec: AgentTemplateSpec) {
  if (!spec.stage) {
    throw new Error(`OpenCode verifier template for ${spec.role} is missing a workflow stage.`);
  }

  const executorLine = `Executor role under review: \`${spec.stage.agentRole}\`.`;

  return [
    "Verify the declared stage report, outputs, and completion criteria.",
    "Write only the verifier evidence JSON at the path declared in the context.",
    "Set `accepted` to true only when the stage evidence satisfies the declared criteria.",
    executorLine
  ];
}

function driverTemplate() {
  return [
    "---",
    'description: "AgentMatrix OpenCode Run Driver"',
    "mode: primary",
    "tools:",
    "  read: true",
    "  write: true",
    "  bash: true",
    "---",
    "",
    "# AgentMatrix OpenCode Run Driver",
    "",
    "You are the primary OpenCode driver for AgentMatrix interactive runs.",
    "",
    "Keep the driver thin. AgentMatrix core owns workflow state, dependency checks, completion criteria, verifier results, rerun invalidation, and resume semantics.",
    "",
    "Use the deterministic JSON Driver Protocol commands from the project root:",
    "",
    "- `agentmatrix driver start` to create a run, or `agentmatrix driver resume [run-id]` to resume one.",
    "- `agentmatrix driver status [run-id]` and `agentmatrix driver next [run-id]` to inspect state.",
    "- `agentmatrix driver prepare-executor [run-id]` to receive the next executor Stage Invocation.",
    "- Invoke the named OpenCode subagent from the Stage Invocation for executor work.",
    "- `agentmatrix driver validate-executor <run-id> --stage <stage-id>` after executor evidence is written.",
    "- `agentmatrix driver prepare-verifier <run-id> --stage <stage-id>` to receive verifier work.",
    "- Invoke the named verifier subagent from the Stage Invocation.",
    "- `agentmatrix driver complete-stage <run-id> --stage <stage-id>` after verifier evidence is written.",
    "",
    "Automatically continue through successful stages unless the human asks for stepwise mode. Stop on failures, blockers, verifier rejection, or explicit user request.",
    "Do not duplicate workflow logic in this prompt; follow Driver Protocol JSON.",
    ""
  ].join("\n");
}

function formatInlineList(values: string[]) {
  return values.length === 0 ? "none" : values.map((value) => `\`${value}\``).join(", ");
}

function formatSkillList(skills: string[]) {
  if (skills.length === 0) {
    return "none";
  }

  return skills.map((skill) => `\`${skill}\` at \`${workflowSkillTemplateRelativePath(skill)}\``).join(", ");
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
