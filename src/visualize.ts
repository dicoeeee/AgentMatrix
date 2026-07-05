import type {
  RunGraph,
  RunState,
  StageStatus,
  VisualizationGraph,
  WorkflowDefinition,
  WorkflowGraph
} from "./types.js";

const STATUS_CLASS_DEFS: Record<StageStatus, string> = {
  pending: "fill:#f8fafc,stroke:#94a3b8,color:#0f172a",
  running: "fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e",
  success: "fill:#dcfce7,stroke:#16a34a,color:#14532d",
  failed: "fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  skipped: "fill:#f3f4f6,stroke:#6b7280,color:#374151"
};

export function runToGraph(runState: RunState): RunGraph {
  return {
    kind: "run",
    runId: runState.id,
    workflowId: runState.workflowId,
    status: runState.status,
    nodes: runState.stages.map((stage) => ({
      id: stage.id,
      status: stage.status
    })),
    edges: stageEdges(runState.stages)
  };
}

export function workflowToGraph(workflow: WorkflowDefinition): WorkflowGraph {
  return {
    kind: "workflow",
    workflowId: workflow.id,
    nodes: workflow.stages.map((stage) => ({
      id: stage.id
    })),
    edges: stageEdges(workflow.stages)
  };
}

export function runToMermaid(runState: RunState) {
  return graphToMermaid(runToGraph(runState));
}

export function workflowToMermaid(workflow: WorkflowDefinition) {
  return graphToMermaid(workflowToGraph(workflow));
}

function graphToMermaid(graph: VisualizationGraph) {
  const nodeNames = new Map(graph.nodes.map((node, index) => [node.id, `stage_${index}`]));
  const lines = ["graph TD"];

  for (const node of graph.nodes) {
    const statusLabel = node.status ? ` (${node.status})` : "";
    lines.push(`  ${nodeNames.get(node.id)}["${escapeMermaidLabel(`${node.id}${statusLabel}`)}"]`);
  }

  for (const edge of graph.edges) {
    const from = nodeNames.get(edge.from);
    const to = nodeNames.get(edge.to);
    if (from && to) {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  const statuses = new Set(graph.nodes.flatMap((node) => (node.status ? [node.status] : [])));
  for (const node of graph.nodes) {
    if (node.status) {
      lines.push(`  class ${nodeNames.get(node.id)} ${node.status};`);
    }
  }

  for (const status of statuses) {
    lines.push(`  classDef ${status} ${STATUS_CLASS_DEFS[status]};`);
  }

  return `${lines.join("\n")}\n`;
}

function escapeMermaidLabel(label: string) {
  return label.replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

function stageEdges(stages: Array<{ id: string; dependsOn: string[] }>) {
  return stages.flatMap((stage) =>
    stage.dependsOn.map((dependency) => ({
      from: dependency,
      to: stage.id
    }))
  );
}
