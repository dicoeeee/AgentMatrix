# Use OpenCode Primary Driver For Interactive Runs

AgentMatrix will make the first interactive run experience OpenCode-first by adding an OpenCode primary driver agent that advances a run stage by stage inside the OpenCode main session. This preserves AgentMatrix workflow, run state, evidence, and verifier semantics while making progress, tool activity, artifacts, and failure points visible enough for human correction between stages.

**Considered Options**

- Keep `agentmatrix run --runtime opencode` as the primary entrypoint and make verbose output richer.
- Have AgentMatrix invoke workflow stage agents directly through `opencode run --agent <role>`.
- Add an OpenCode primary driver agent that coordinates AgentMatrix stage execution and uses stage executor/verifier agents as subagents.

**Consequences**

The CLI remains useful for non-interactive and compatibility paths, but the OpenCode dogfooding path moves to a platform-native primary agent. Stage executor and verifier templates can remain subagents; this avoids relying on `opencode run --agent <stage>` for subagent templates, which can fall back to the default agent instead of using the intended role.

The primary driver agent must stay thin: it can present state, ask the human what to do next, and call AgentMatrix entrypoints, but AgentMatrix core remains the only workflow state machine for dependency checks, rerun invalidation, completion criteria, verification, and resume semantics.

The first driver-to-core interface will be a deterministic JSON CLI protocol rather than an MCP server or long-running AgentMatrix service. This keeps the OpenCode driver easy to inspect and dogfood while preserving a stable contract that later platform drivers can reuse or wrap.

The first driver protocol will advance one workflow stage per step: executor, AgentMatrix validation, verifier, state persistence, and then return control to the OpenCode driver. Higher-level auto-run modes can be added later, but the OpenCode dogfooding path should make every stage boundary inspectable and interruptible by default.

Interactive driver pauses do not add a new run status. A run remains `running` while it is paused at a stage boundary because the pause belongs to the driver conversation, not to AgentMatrix's workflow state model.

The OpenCode driver should default to automatically continuing through successful stages and stop only when a stage fails, reports a blocker, is rejected by a verifier, or the user explicitly requests stepwise inspection. Manual confirmation at every stage boundary remains a driver interaction mode, not the default workflow behavior.

For platform-managed stages, the OpenCode driver should use OpenCode's subagent mechanism directly instead of asking AgentMatrix to nest `opencode run --agent <stage>`. AgentMatrix core prepares stage invocations, validates produced evidence, prepares verifier invocations, and updates run state after verifier evidence is written; the primary driver owns only the platform interaction.
