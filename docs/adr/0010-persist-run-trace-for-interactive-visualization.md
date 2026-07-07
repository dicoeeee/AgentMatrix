# Persist Run Trace For Interactive Visualization

AgentMatrix will introduce a first-class Run Trace as the source of truth for interactive run visualization. The Run Trace records observable execution milestones across the driver, executor agents, verifier agents, subagents, commands, artifacts, and AgentMatrix validation decisions, instead of asking `agentmatrix visualize` to infer those milestones from final summaries, stage reports, verbose output, or OpenCode stdout.

The Run Trace is not a model-thinking transcript or a full audit log. It should show the workflow skeleton: which stage was prepared, which agent role was invoked, which command or script summary matters, whether executor validation passed, whether verifier evidence accepted the stage, and why the run stopped or completed. Detailed agent, skill, command, stdout, stderr, and platform observations should remain in logs or evidence artifacts linked from trace events.

**Considered Options**

- Keep enriching `stage-report.json` and per-stage evidence, then infer visualization from those files.
- Scrape OpenCode JSON stdout or platform session transcripts to reconstruct agent and tool activity.
- Add a structured Run Trace that AgentMatrix core owns and platform drivers append to through the Driver Protocol.

**Consequences**

`run.json` remains the compact workflow state machine. It should not become a full timeline of agent activity. The Run Trace should live alongside run state under the run directory as JSON Lines, for example `.agentmatrix/runs/<run-id>/trace.jsonl`, so visualization can read a compact execution index without changing the state model. JSON Lines is preferred over a JSON array because trace writes are append-only and can be parsed event by event.

AgentMatrix core should append deterministic boundary events such as run start, stage prepared, executor evidence validated, verifier prepared, verifier result accepted or rejected, stage completed, stage failed, and run completed. These events are core-owned because they correspond to workflow state transitions and completion criteria.

The OpenCode Run Driver should record compact platform-observed milestones such as executor subagent invocation, verifier subagent invocation, child checker subagent starts, and important command or script summaries. Detailed platform observations should go to per-stage logs or evidence artifacts; AgentMatrix can link those logs without treating them as workflow authority.

Trace writes from OpenCode should go through a Driver Protocol verb, initially `agentmatrix driver record-event <run-id>`, rather than having OpenCode agents append directly to `trace.jsonl`. AgentMatrix core owns event schema validation, timestamping, path normalization, run and stage existence checks, and append behavior.

The first implementation should prefer this small structured append contract over transcript scraping. Only the OpenCode primary driver should call `record-event`. Executor, verifier, and child subagents should write stage reports, evidence, and stage logs; the primary driver should read those outputs at stage boundaries and submit only visualization-relevant summaries through `record-event`. This keeps trace writes serialized, avoids duplicate subagent events, and gives visualization one stable data shape.

Core-owned deterministic trace events should be written automatically by AgentMatrix when Driver Protocol verbs advance state. `driver start`, `driver resume`, `driver prepare-executor`, `driver validate-executor`, `driver prepare-verifier`, `driver complete-stage`, and run completion or failure should record the corresponding Run Trace milestones without requiring the OpenCode driver to call `record-event`. `record-event` is only for compact platform observations that AgentMatrix cannot know directly, such as which OpenCode subagent was invoked or how many child checker shards were launched.

The OpenCode primary driver template should be updated to describe this split. It should tell the primary driver that AgentMatrix core records deterministic state boundaries automatically, and that the primary driver should call `record-event` only for platform summaries such as executor subagent invocation, verifier subagent invocation, checker shard count, and notable command summaries. Executor, verifier, and child subagent templates should not be instructed to call `record-event` directly.

Run Trace should use a small fixed event kind vocabulary rather than free-form event names. The first vocabulary should cover `stage_prepared`, `agent_invoked`, `command_completed`, `artifact_written`, `executor_validated`, `verifier_prepared`, `verifier_completed`, `stage_completed`, `stage_failed`, `run_completed`, and `run_failed`. Detailed command timing, skill usage, stdout, stderr, and platform-specific tool events belong in linked logs or evidence, not in the trace event body.

Detailed logs should be split by stage and role instead of written to one run-wide log. The default paths should be under the stage artifact directory, for example `.agentmatrix/artifacts/<run-id>/<stage-id>/executor.log`, `.agentmatrix/artifacts/<run-id>/<stage-id>/verifier.log`, and `.agentmatrix/artifacts/<run-id>/<stage-id>/subagents/<name>.log` when child subagent logs are available. Trace events should link to these paths with a compact `log_path` or equivalent field.

`agentmatrix visualize` should read the Run Trace first and fall back to existing stage-report `parallel_group` and evidence-derived activities for older runs. The visualization should make executor and verifier results explicit, including verifier rejection, verifier acceptance, missing evidence, failed commands, blockers, and any stop reason.

Runs created before `trace.jsonl` exists must remain visualizable. When a trace file is absent, `agentmatrix visualize` should keep using existing run state, stage reports, and evidence-derived activities as a compatibility fallback.

The primary human debugging surface should be an HTML Run Detail View generated by `agentmatrix visualize --open`. Mermaid and JSON output should remain available for compatibility and automation, but Mermaid should not be the main surface for detailed run inspection. The HTML view should show the stage flow near the top and a compact per-stage detail area with executor status, verifier status, command summaries, failure or blocker summaries, and links to stage reports, evidence, and logs.

The HTML Run Detail View should not embed full logs in the first version. It should show compact summaries, failure or blocker excerpts when available, and links to `stage-report.json`, executor evidence, verifier evidence, and Stage Logs. Keeping logs out of the page avoids slow or noisy visualizations while still making detailed debugging one click away.

In-run visualization should use lightweight refresh rather than a live server. The first version should regenerate or refresh the static HTML Run Detail View at stage boundaries and may include a simple browser auto-refresh interval while the run is still `running`. AgentMatrix should not introduce WebSocket, server-sent events, a persistent web server, or a long-running visualization service for this first version.

Trace events should stay small. Each event should include run id, stage id when available, event kind, status, timestamp, a short label or summary, and relevant log or evidence paths. Long stdout, stderr, detailed platform events, and hidden model reasoning should stay out of the trace.

The first trace event schema should stay minimal: `schema_version`, `run_id`, optional `stage_id`, `kind`, optional `status`, `label`, optional `summary`, `at`, and optional `paths`. The `paths` field should carry named references such as `stage_report_path`, `executor_evidence_path`, `verifier_evidence_path`, `log_path`, or related artifact paths. The first version should not include generic `actor`, `source`, or `metadata` fields; if those become necessary, they should be added through a schema version change.

The `record-event` verb should take the run id as a positional argument and read the event body as JSON from stdin, for example `agentmatrix driver record-event <run-id> < event.json`. This avoids CLI escaping issues for summaries and paths, and lets AgentMatrix validate one JSON document before appending it. The submitted event may omit `at`; AgentMatrix should fill the timestamp when it records the event.

**First Version Scope**

The first implementation should stay limited to:

- Add `trace.jsonl` Run Trace storage with the minimal trace event schema and core-owned deterministic trace events.
- Add `agentmatrix driver record-event <run-id>` with stdin JSON input for OpenCode primary driver platform summaries only.
- Add Stage Log path conventions and update the OpenCode primary driver template to explain the core/driver split.
- Make `agentmatrix visualize --open` generate an HTML Run Detail View with lightweight refresh, stage summaries, executor/verifier results, and links to logs and evidence.
- Preserve existing visualization fallback behavior for older runs without `trace.jsonl`.
