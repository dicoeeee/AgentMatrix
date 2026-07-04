import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkflowRuntimeAdapter } from "./types.js";

export function createMockRuntimeAdapter(): WorkflowRuntimeAdapter {
  return {
    async executeStage(context) {
      await writeJson(context.projectRoot, context.executorEvidencePath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        agent_role: context.stage.agentRole,
        status: "success",
        summary: `Mock executor completed ${context.stage.id}.`,
        outputs: [{ id: "stage_report", path: context.stageReportPath }]
      });
      await writeJson(context.projectRoot, context.stageReportPath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        status: "success",
        summary: `Mock executor completed ${context.stage.id}.`,
        commands: [],
        findings: [],
        artifacts: [context.executorEvidencePath],
        skipped: [],
        changed_files: []
      });

      return {
        stageReportPath: context.stageReportPath,
        evidencePath: context.executorEvidencePath
      };
    },
    async verifyStage(context) {
      await writeJson(context.projectRoot, context.verifierEvidencePath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        verifier_role: context.stage.verifierRole,
        accepted: true,
        checked_artifact: context.stageReportPath,
        summary: `Mock verifier accepted ${context.stage.id}.`
      });

      return {
        accepted: true,
        evidencePath: context.verifierEvidencePath
      };
    }
  };
}

async function writeJson(projectRoot: string, relativePath: string, data: unknown) {
  const filePath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
}
