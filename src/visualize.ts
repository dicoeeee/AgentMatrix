import type {
  RunGraph,
  RunState,
  RunStageState,
  StageStatus,
  VisualizationGraph,
  WorkflowDefinition,
  WorkflowGraph
} from "./types.js";
import type { RunTraceEvent, RunTraceEventKind } from "./run-trace.js";

const STATUS_CLASS_DEFS: Record<StageStatus, string> = {
  pending: "fill:#f8fafc,stroke:#94a3b8,stroke-width:2px,color:#0f172a",
  running: "fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0c4a6e",
  success: "fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d",
  failed: "fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d",
  skipped: "fill:#f3f4f6,stroke:#6b7280,stroke-width:2px,color:#374151"
};
const ACTIVITY_CLASS_DEFS = {
  parallelActivity: "fill:#eef2ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81,stroke-dasharray:4 3"
};

export interface StageVisualizationActivity {
  kind: "command" | "subagent";
  label: string;
  group: string;
  status?: string;
  detail?: string;
}

export interface StageVisualizationDetails {
  stageId: string;
  activities: StageVisualizationActivity[];
}

export interface RunVisualizationDetails {
  stages: StageVisualizationDetails[];
}

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

export function runToMermaid(runState: RunState, details?: RunVisualizationDetails) {
  return graphToMermaid(runToGraph(runState), details);
}

export function workflowToMermaid(workflow: WorkflowDefinition) {
  return graphToMermaid(workflowToGraph(workflow));
}

export function mermaidToHtml(title: string, mermaidSource: string) {
  const escapedTitle = escapeHtml(title);
  const escapedMermaid = escapeHtml(mermaidSource);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    :root {
      color: #172033;
      background: #eef3f8;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, #f8fbfe 0%, #eef3f8 52%, #e9eef5 100%);
    }

    header {
      border-bottom: 1px solid #d6deea;
      background: rgba(255, 255, 255, 0.88);
      padding: 22px 32px 18px;
    }

    .eyebrow {
      margin: 0 0 6px;
      color: #667085;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0;
    }

    main {
      box-sizing: border-box;
      min-height: calc(100vh - 92px);
      padding: 28px;
    }

    .surface {
      box-sizing: border-box;
      min-height: calc(100vh - 148px);
      overflow: auto;
      border: 1px solid #cfd8e6;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 18px 50px rgba(42, 56, 82, 0.12);
    }

    .diagram {
      min-width: 920px;
      min-height: 520px;
      margin: 0;
      padding: 36px;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 14px 18px;
      border-bottom: 1px solid #e1e7f0;
      color: #475467;
      font-size: 13px;
      background: #fbfcfe;
    }

    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
    }

    .legend i {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #94a3b8;
    }

    .legend .success { background: #16a34a; }
    .legend .running { background: #0284c7; }
    .legend .failed { background: #dc2626; }
    .legend .parallel { background: #4f46e5; }

    .mermaid svg {
      display: block;
      margin: 0 auto;
      max-width: none;
    }

    .mermaid .cluster rect {
      fill: #f8fafc !important;
      stroke: #d8e0ec !important;
      rx: 8px !important;
    }

    .mermaid .edgePath .path {
      stroke: #7d8aa3 !important;
      stroke-width: 1.8px !important;
    }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">AgentMatrix visualization</p>
    <h1>${escapedTitle}</h1>
  </header>
  <main>
    <section class="surface">
      <div class="legend">
        <span><i class="success"></i>Success</span>
        <span><i class="running"></i>Running</span>
        <span><i class="failed"></i>Failed</span>
        <span><i class="parallel"></i>Parallel activity</span>
      </div>
      <pre class="mermaid diagram">${escapedMermaid}</pre>
    </section>
  </main>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({
      startOnLoad: true,
      securityLevel: "strict",
      theme: "base",
      htmlLabels: true,
      flowchart: {
        curve: "basis",
        nodeSpacing: 46,
        rankSpacing: 68,
        useMaxWidth: false
      },
      themeVariables: {
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        primaryBorderColor: "#cfd8e6",
        lineColor: "#7d8aa3",
        clusterBkg: "#f8fafc",
        clusterBorder: "#d8e0ec"
      }
    });
  </script>
</body>
</html>
`;
}

export function runDetailToHtml(
  title: string,
  runState: RunState,
  traceEvents: RunTraceEvent[],
  mermaidSource: string,
  details?: RunVisualizationDetails
) {
  const escapedTitle = escapeHtml(title);
  const refresh = runState.status === "running" ? '  <meta http-equiv="refresh" content="8">\n' : "";
  const runMilestones = traceEvents.filter((event) => !event.stage_id);
  const escapedMermaid = escapeHtml(mermaidSource);
  const activitiesByStage = new Map(details?.stages.map((stage) => [stage.stageId, stage.activities]) ?? []);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}  <title>${escapedTitle}</title>
  <style>
    :root {
      color: #172033;
      background: #f4f6f8;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: #f4f6f8;
    }

    header {
      border-bottom: 1px solid #d7dee8;
      background: #ffffff;
      padding: 22px 32px 18px;
    }

    .eyebrow {
      margin: 0 0 6px;
      color: #667085;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0;
    }

    main {
      box-sizing: border-box;
      max-width: 1160px;
      margin: 0 auto;
      padding: 26px 24px 40px;
    }

    h2 {
      margin: 0 0 12px;
      font-size: 17px;
      letter-spacing: 0;
    }

    h3 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }

    h4 {
      margin: 14px 0 8px;
      color: #344054;
      font-size: 13px;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }

    .summary div,
    .section {
      border: 1px solid #d7dee8;
      border-radius: 8px;
      background: #ffffff;
    }

    .summary div {
      padding: 14px 16px;
    }

    .summary span {
      display: block;
      color: #667085;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .summary strong {
      display: block;
      margin-top: 5px;
      font-size: 18px;
    }

    .section {
      margin-top: 18px;
      padding: 18px;
    }

    .stage-flow {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .flow-item,
    .stage-detail {
      border: 1px solid #d7dee8;
      border-radius: 8px;
      background: #fbfcfe;
    }

    .flow-item {
      padding: 12px;
    }

    .flow-item span {
      display: block;
      margin-bottom: 8px;
      font-weight: 700;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      background: #eef2f6;
      color: #475467;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .badge.running { background: #e0f2fe; color: #075985; }
    .badge.success { background: #dcfce7; color: #166534; }
    .badge.failed { background: #fee2e2; color: #991b1b; }
    .badge.skipped { background: #f3f4f6; color: #4b5563; }

    .stage-detail {
      margin-top: 12px;
      padding: 14px;
    }

    .stage-heading {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }

    .milestone-list {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .activity-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .milestone,
    .activity {
      display: grid;
      grid-template-columns: minmax(136px, 180px) 1fr auto;
      gap: 10px;
      align-items: start;
      border-top: 1px solid #e4e9f0;
      padding-top: 10px;
    }

    .milestone:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .activity:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .event-kind,
    .activity-kind {
      color: #344054;
      font-weight: 700;
    }

    .event-body p,
    .activity-body p {
      margin: 4px 0 0;
      color: #475467;
      line-height: 1.45;
    }

    .time {
      color: #667085;
      font-size: 12px;
      white-space: nowrap;
    }

    .paths {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .paths a {
      color: #175cd3;
      font-size: 12px;
      text-decoration: none;
    }

    .paths a:hover {
      text-decoration: underline;
    }

    details {
      margin-top: 16px;
    }

    summary {
      cursor: pointer;
      color: #344054;
      font-weight: 700;
    }

    pre {
      overflow: auto;
      border: 1px solid #d7dee8;
      border-radius: 8px;
      background: #101828;
      color: #f8fafc;
      padding: 14px;
    }

    @media (max-width: 760px) {
      header {
        padding: 18px 20px;
      }

      main {
        padding: 18px 14px 32px;
      }

      .milestone {
        grid-template-columns: 1fr;
      }

      .activity {
        grid-template-columns: 1fr;
      }

      .time {
        white-space: normal;
      }
    }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">AgentMatrix Run Detail View</p>
    <h1>${escapedTitle}</h1>
  </header>
  <main>
    <section class="summary" aria-label="Run summary">
      <div><span>Run</span><strong>${escapeHtml(runState.id)}</strong></div>
      <div><span>Workflow</span><strong>${escapeHtml(runState.workflowId)}</strong></div>
      <div><span>Status</span><strong>${escapeHtml(displayName(runState.status))}</strong></div>
      <div><span>Trace events</span><strong>${traceEvents.length}</strong></div>
    </section>

    <section class="section">
      <h2>Stage Flow</h2>
      <ol class="stage-flow">
        ${runState.stages.map((stage) => renderStageFlowItem(stage)).join("\n        ")}
      </ol>
    </section>

    <section class="section">
      <h2>Core Milestones</h2>
      ${renderTraceEventList(runMilestones)}
    </section>

    <section class="section">
      <h2>Stage Details</h2>
      ${runState.stages
        .map((stage) => renderStageDetail(stage, traceEvents, activitiesByStage.get(stage.id) ?? []))
        .join("\n      ")}
    </section>

    <details>
      <summary>Mermaid graph</summary>
      <pre>${escapedMermaid}</pre>
    </details>
  </main>
</body>
</html>
`;
}

function graphToMermaid(graph: VisualizationGraph, details?: RunVisualizationDetails) {
  const nodeNames = new Map(graph.nodes.map((node, index) => [node.id, `stage_${index}`]));
  const lines = ["graph TD"];
  const activitiesByStage = new Map(
    details?.stages.map((stage) => [stage.stageId, stage.activities]) ?? []
  );

  for (const [index, node] of graph.nodes.entries()) {
    const nodeName = nodeNames.get(node.id);
    if (!nodeName) {
      continue;
    }

    const activities = activitiesByStage.get(node.id) ?? [];
    if (activities.length === 0) {
      lines.push(`  ${nodeName}["${escapeMermaidLabel(stageLabel(node.id, node.status))}"]`);
      continue;
    }

    lines.push(`  subgraph stage_${index}_group["${escapeMermaidLabel(displayName(node.id))}"]`);
    lines.push("    direction TB");
    lines.push(`    ${nodeName}["${escapeMermaidLabel(stageLabel(node.id, node.status))}"]`);
    for (const [activityIndex, activity] of activities.entries()) {
      const activityName = `${nodeName}_activity_${activityIndex}`;
      lines.push(`    ${activityName}["${escapeMermaidLabel(activityLabel(activity))}"]`);
      lines.push(`    ${nodeName} -.-> ${activityName}`);
    }
    lines.push("  end");
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
  for (const [nodeId, activities] of activitiesByStage.entries()) {
    const nodeName = nodeNames.get(nodeId);
    if (!nodeName) {
      continue;
    }
    for (const [activityIndex] of activities.entries()) {
      lines.push(`  class ${nodeName}_activity_${activityIndex} parallelActivity;`);
    }
  }

  for (const status of statuses) {
    lines.push(`  classDef ${status} ${STATUS_CLASS_DEFS[status]};`);
  }
  for (const [className, classDef] of Object.entries(ACTIVITY_CLASS_DEFS)) {
    lines.push(`  classDef ${className} ${classDef};`);
  }

  return `${lines.join("\n")}\n`;
}

function stageLabel(id: string, status?: StageStatus) {
  const statusLabel = status ? `${id} (${status})` : id;
  return `${escapeHtml(displayName(id))}<br/><small>${escapeHtml(statusLabel)}</small>`;
}

function activityLabel(activity: StageVisualizationActivity) {
  const lines = [
    activity.label,
    `parallel group: ${activity.group}`,
    activity.detail,
    activity.status ? `status: ${activity.status}` : undefined
  ].filter((line): line is string => Boolean(line));

  return lines.map((line) => escapeHtml(truncateLabel(line))).join("<br/>");
}

function renderStageFlowItem(stage: RunStageState) {
  return `<li class="flow-item"><span>${escapeHtml(stage.name)}</span>${renderStatusBadge(stage.status)}</li>`;
}

function renderStageDetail(
  stage: RunStageState,
  traceEvents: RunTraceEvent[],
  fallbackActivities: StageVisualizationActivity[]
) {
  const events = traceEvents.filter((event) => event.stage_id === stage.id);
  const executor = events.find((event) => event.kind === "executor_validated");
  const verifier = events.find((event) => event.kind === "verifier_completed");
  const statusSummary = [
    executor ? `Executor ${executor.status ?? "recorded"}` : "Executor not recorded",
    verifier ? `Verifier ${verifier.status ?? "recorded"}` : "Verifier not recorded"
  ].join(" - ");

  return `<article class="stage-detail">
        <div class="stage-heading">
          <h3>${escapeHtml(stage.name)}</h3>
          <div>${renderStatusBadge(stage.status)}</div>
        </div>
        <p>${escapeHtml(statusSummary)}</p>
        ${renderTraceEventList(events)}
        ${renderFallbackActivities(fallbackActivities)}
      </article>`;
}

function renderFallbackActivities(activities: StageVisualizationActivity[]) {
  if (activities.length === 0) {
    return "";
  }

  return `<div class="fallback-activities">
          <h4>Fallback Activity</h4>
          <ol class="activity-list">
            ${activities.map((activity) => renderFallbackActivity(activity)).join("\n            ")}
          </ol>
        </div>`;
}

function renderFallbackActivity(activity: StageVisualizationActivity) {
  return `<li class="activity">
              <span class="activity-kind">${escapeHtml(displayName(activity.kind))}</span>
              <div class="activity-body">
                <strong>${escapeHtml(activity.label)}</strong>
                <p>parallel group: ${escapeHtml(activity.group)}</p>
                ${activity.detail ? `<p>${escapeHtml(activity.detail)}</p>` : ""}
              </div>
              <div>${activity.status ? renderStatusBadge(activity.status) : ""}</div>
            </li>`;
}

function renderTraceEventList(events: RunTraceEvent[]) {
  if (events.length === 0) {
    return '<p>No trace milestones recorded.</p>';
  }

  return `<ol class="milestone-list">
        ${events.map((event) => renderTraceEvent(event)).join("\n        ")}
      </ol>`;
}

function renderTraceEvent(event: RunTraceEvent) {
  return `<li class="milestone">
          <span class="event-kind">${escapeHtml(eventKindLabel(event.kind))}</span>
          <div class="event-body">
            <strong>${escapeHtml(event.label)}</strong>
            ${event.summary ? `<p>${escapeHtml(event.summary)}</p>` : ""}
            ${renderTracePathLinks(event.paths)}
          </div>
          <div>
            ${event.status ? renderStatusBadge(event.status) : ""}
            <div class="time">${escapeHtml(event.at)}</div>
          </div>
        </li>`;
}

function renderTracePathLinks(paths: Record<string, string> | undefined) {
  if (!paths || Object.keys(paths).length === 0) {
    return "";
  }

  const links = Object.entries(paths).map(
    ([name, value]) =>
      `<a href="${escapeHtml(pathHref(value))}">${escapeHtml(displayName(name))}: ${escapeHtml(value)}</a>`
  );

  return `<div class="paths">${links.join("")}</div>`;
}

function renderStatusBadge(status: string) {
  const normalized = status.toLowerCase();
  const className = ["running", "success", "failed", "skipped"].includes(normalized) ? normalized : "";
  return `<span class="badge ${className}">${escapeHtml(displayName(status))}</span>`;
}

function eventKindLabel(kind: RunTraceEventKind) {
  return displayName(kind);
}

function pathHref(projectRelativePath: string) {
  const normalized = projectRelativePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.startsWith(".agentmatrix/")) {
    return `../${normalized.slice(".agentmatrix/".length)}`;
  }
  return `../../${normalized}`;
}

function displayName(id: string) {
  const acronyms: Record<string, string> = {
    api: "API",
    json: "JSON",
    mr: "MR",
    pr: "PR",
    ui: "UI"
  };

  return id
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => acronyms[part.toLowerCase()] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function truncateLabel(value: string) {
  return value.length > 84 ? `${value.slice(0, 81)}...` : value;
}

function escapeMermaidLabel(label: string) {
  return label.replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stageEdges(stages: Array<{ id: string; dependsOn: string[] }>) {
  return stages.flatMap((stage) =>
    stage.dependsOn.map((dependency) => ({
      from: dependency,
      to: stage.id
    }))
  );
}
