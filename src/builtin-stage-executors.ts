import { DEFAULT_WORKFLOW_ID } from "./templates.js";

export function usesAgentMatrixStaticCheckExecutor(workflowId: string, stageId: string) {
  return workflowId === DEFAULT_WORKFLOW_ID && stageId === "static_check";
}
