# Use Static Check Skill Agent For OpenCode Interactive Runs

The OpenCode interactive run path will execute `static_check` through the OpenCode `static_check` subagent and the project-local `.agentmatrix/skills/static-check/SKILL.md`, rather than through AgentMatrix's built-in static check scheduler. Static checking needs to focus on the run's change scope and adapt to project-specific languages, toolchains, analyzer configs, and CI conventions, which is better handled by a stage agent following the static-check skill than by core hard-coding language command guesses.

**Consequences**

AgentMatrix core should prepare the stage invocation, provide change-scope context, require the subagent to use the static-check skill and relevant language references, then validate the produced stage report and evidence. The existing built-in `executeStaticCheckStage` can remain as a mock/runtime fallback or compatibility path, but it is not the preferred OpenCode interactive execution model.

AgentMatrix core owns change-scope calculation for stage invocations. In git repositories it should derive changed files and diff summary from the current branch, default-branch merge base, staged changes, unstaged changes, and untracked files. Outside git repositories it should mark the change scope as unknown so the static-check agent can report that limitation and fall back to discoverable project clues.

The static-check agent may apply safe mechanical repairs such as formatter output, lint autofix, import ordering, or project-tool-generated static fixes, but it must stay within the change scope by default. If a tool needs to modify files outside the change scope, the agent must report the reason and exact files; broader behavior or public API changes are blockers rather than static-check repairs.

The first OpenCode interactive version will not mechanically verify change coverage. For large change scopes, the static-check agent should split the change scope into check shards and launch multiple focused subagents so broad changes are inspected with more parallel attention, while the verifier remains focused on report/evidence validity and obvious scope omissions rather than proving full file coverage.

AgentMatrix core should provide a large-change hint and suggested check shards in the stage invocation when the change scope is broad, initially around eight or more changed files or roughly five hundred or more changed lines. The static-check agent owns the final sharding decision, subagent launch, and synthesis into a single stage report.
