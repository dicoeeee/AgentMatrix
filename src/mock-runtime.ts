import path from "node:path";

import { executeCodeReviewStage } from "./code-review.js";
import { writeProjectJson, writeProjectText } from "./project-files.js";
import { executeStaticCheckStage, type StaticCheckOptions } from "./static-check.js";
import { executeTestCheckStage, type TestCheckOptions } from "./test-check.js";
import type { WorkflowOutput, WorkflowRuntimeAdapter } from "./types.js";

export interface MockRuntimeOptions {
  staticCheck?: StaticCheckOptions;
  testCheck?: TestCheckOptions;
}

export function createMockRuntimeAdapter(options: MockRuntimeOptions = {}): WorkflowRuntimeAdapter {
  return {
    async executeStage(context) {
      if (context.stage.id === "static_check") {
        return executeStaticCheckStage(context, options.staticCheck);
      }
      if (context.stage.id === "test_check") {
        return executeTestCheckStage(context, options.testCheck);
      }
      if (context.stage.id === "code_review") {
        return executeCodeReviewStage(context);
      }

      const outputArtifacts = context.stage.outputs.map((output) =>
        path.join(context.runState.artifactPath, output.path)
      );
      await writeProjectJson(context.projectRoot, context.executorEvidencePath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        agent_role: context.stage.agentRole,
        status: "success",
        summary: `Mock executor completed ${context.stage.id}.`,
        outputs: [{ id: "stage_report", path: context.stageReportPath }]
      });
      await writeProjectJson(context.projectRoot, context.stageReportPath, {
        schema_version: 1,
        run_id: context.runState.id,
        stage_id: context.stage.id,
        status: "success",
        summary: `Mock executor completed ${context.stage.id}.`,
        commands: [],
        findings: [],
        artifacts: outputArtifacts,
        skipped: [],
        changed_files: [],
        blockers: []
      });
      await writeAdditionalOutputs(
        context.projectRoot,
        context.stage.outputs,
        context.stageReportPath,
        context.runState.artifactPath
      );

      return {
        stageReportPath: context.stageReportPath,
        evidencePath: context.executorEvidencePath
      };
    },
    async verifyStage(context) {
      await writeProjectJson(context.projectRoot, context.verifierEvidencePath, {
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

async function writeAdditionalOutputs(
  projectRoot: string,
  outputs: WorkflowOutput[],
  stageReportPath: string,
  artifactPath: string
) {
  for (const output of outputs) {
    const outputPath = path.join(artifactPath, output.path);
    if (outputPath === stageReportPath) {
      continue;
    }

    await writeProjectText(projectRoot, outputPath, mockOutput(output.id));
  }
}

function mockOutput(outputId: string) {
  if (outputId === "mr_title") {
    return "Mock MR title\n";
  }

  if (outputId === "mr_description") {
    return "Mock MR description\n";
  }

  return `Mock output for ${outputId}\n`;
}
