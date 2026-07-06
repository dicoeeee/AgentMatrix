import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENTMATRIX_DIR, type WorkflowDefinition } from "./types.js";

export interface SkillTemplateInstallResult {
  created: string[];
  skipped: string[];
  unavailable: string[];
}

const BUNDLED_SKILL_TEMPLATE_DIRS: Record<string, string> = {
  "static-check": "static-check",
  "industry-code-review": "industry-code-review"
};

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function installWorkflowSkillTemplates(
  projectRoot: string,
  workflow: WorkflowDefinition
): Promise<SkillTemplateInstallResult> {
  const skillsDir = path.join(projectRoot, AGENTMATRIX_DIR, "skills");
  await mkdir(skillsDir, { recursive: true });

  const result: SkillTemplateInstallResult = {
    created: [],
    skipped: [],
    unavailable: []
  };

  for (const skillId of workflowSkillIds(workflow)) {
    const sourceDir = bundledSkillTemplateSourceDir(skillId);
    if (!sourceDir) {
      result.unavailable.push(skillId);
      continue;
    }

    const relativePath = path.join(AGENTMATRIX_DIR, "skills", skillId);
    const destinationDir = path.join(projectRoot, relativePath);

    if (await pathExists(destinationDir)) {
      result.skipped.push(relativePath);
      continue;
    }

    await cp(sourceDir, destinationDir, { recursive: true });
    result.created.push(relativePath);
  }

  return result;
}

export function workflowSkillTemplateRelativePath(skillId: string) {
  return path.join(AGENTMATRIX_DIR, "skills", skillId, "SKILL.md");
}

function workflowSkillIds(workflow: WorkflowDefinition) {
  return [...new Set(workflow.stages.flatMap((stage) => stage.skills))];
}

function bundledSkillTemplateSourceDir(skillId: string) {
  const sourceDirName = BUNDLED_SKILL_TEMPLATE_DIRS[skillId];
  if (!sourceDirName) {
    return undefined;
  }

  return path.join(PACKAGE_ROOT, sourceDirName);
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

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
