import type { RunGraph, RunState } from "./types.js";

export function runToGraph(runState: RunState): RunGraph {
  return {
    runId: runState.id,
    workflowId: runState.workflowId,
    status: runState.status,
    nodes: runState.stages.map((stage) => ({
      id: stage.id,
      status: stage.status
    })),
    edges: runState.stages.flatMap((stage) =>
      stage.dependsOn.map((dependency) => ({
        from: dependency,
        to: stage.id
      }))
    )
  };
}

export function runToMermaid(runState: RunState) {
  const graph = runToGraph(runState);
  const nodeNames = new Map(graph.nodes.map((node, index) => [node.id, `stage_${index}`]));
  const lines = ["graph TD"];

  for (const node of graph.nodes) {
    lines.push(`  ${nodeNames.get(node.id)}["${escapeMermaidLabel(`${node.id} (${node.status})`)}"]`);
  }

  for (const edge of graph.edges) {
    const from = nodeNames.get(edge.from);
    const to = nodeNames.get(edge.to);
    if (from && to) {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function escapeMermaidLabel(label: string) {
  return label.replace(/"/g, '\\"');
}
