# PRD: AgentMatrix workflow orchestration MVP

## Problem Statement

AI coding agents can execute individual tasks, but they do not reliably manage a multi-stage engineering workflow from "code is done" to "MR-ready output". Users need the agent to know which phase it is in, what evidence proves the phase is complete, when a repair invalidates earlier work, and how to resume or visualize the workflow without relying on ad hoc prompts.

AgentMatrix should provide a workflow orchestration system that can run on top of agent platforms such as opencode first, and later Codex or Claude Code, without modifying those platforms' kernels. The first proving workflow is the post-coding MR preflight flow: static checks, tests, code review, and MR description preparation.

## Solution

Build AgentMatrix as a portable workflow orchestration kit. It provides a TypeScript/Node CLI, YAML workflow definitions, file-system-backed run state, evidence records, verifier-driven stage completion, repair/rerun handling, and run-state visualization.

The MVP should prove the orchestration model through one built-in workflow, `mr-preflight`, copied into the project during initialization and editable by the user. The workflow is linear at the stage level but supports parallel work inside a stage. Each stage is executed by a logical agent role, then verified by a verifier agent before the runtime advances.

AgentMatrix core should stay platform-neutral where it matters: workflow, stage, runtime state, evidence, stage status, completion criteria, and CLI verbs. Platform-specific concerns such as opencode commands, Claude Code skills-as-commands, Codex skills/plugins, and platform agent definitions live outside the core as platform packages or adapter targets.

## User Stories

1. As a developer, I want to initialize AgentMatrix in a project, so that I can start using a predefined workflow without writing everything from scratch.
2. As a developer, I want to choose an internal workflow template during initialization, so that I can start from a known-good flow.
3. As a developer, I want the `mr-preflight` workflow copied into my project, so that I can edit and version it with my codebase.
4. As a developer, I want workflow definitions to be YAML, so that they are readable and reviewable by humans.
5. As a developer, I want workflow definitions validated by schema, so that malformed workflows fail before execution.
6. As a developer, I want `agentmatrix run` to always start a fresh workflow run, so that run semantics are predictable.
7. As a developer, I want `agentmatrix resume` to continue an existing run, so that interrupted workflows can continue without restarting.
8. As a developer, I want `agentmatrix status` to show current and past run states, so that I know what is active, complete, or failed.
9. As a developer, I want `agentmatrix visualize` to show a workflow run, so that I can see which stage is failed, skipped, or complete.
10. As a developer, I want run visualization to prioritize run state over static workflow diagrams, so that I can debug real execution progress.
11. As a developer, I want visualization output in Mermaid and JSON, so that it works before a dedicated UI exists.
12. As a workflow author, I want each stage to declare dependencies, inputs, outputs, completion criteria, repair policy, and rerun triggers, so that stage behavior is explicit.
13. As a workflow author, I want stages to reference logical agent roles, so that the workflow is not tied to opencode, Codex, or Claude Code agent file formats.
14. As a platform integrator, I want opencode and Codex to use separate platform agent definitions, so that each platform can use its native execution model.
15. As a platform integrator, I want platform entrypoints to be thin wrappers, so that workflow logic stays in AgentMatrix runtime.
16. As a workflow author, I want AgentMatrix core not to define a cross-platform `command` abstraction, so that platform-specific command semantics do not leak into the core model.
17. As a workflow user, I want resources to be checked before a run starts, so that missing agents, skills, or MCP servers fail early.
18. As a workflow user, I do not want `run` or `resume` to auto-install resources, so that environment preparation and execution remain separate.
19. As a workflow user, I want missing resources to produce a clear failure, so that I know to use the existing installer capability.
20. As a workflow user, I want every stage to produce structured evidence, so that completion is not based only on an agent saying it is done.
21. As a workflow user, I want every stage to be verified by a verifier agent, so that execution and completion judgment are separated.
22. As a verifier agent, I want simple completion criteria such as output existence, schema validity, command success, no blockers, and skip reasons, so that stage verification is deterministic.
23. As a workflow user, I want stage state to be simple, so that visualizations and state transitions remain understandable.
24. As a workflow user, I want stages to use `pending`, `running`, `success`, `failed`, and `skipped`, so that the main state machine stays compact.
25. As a workflow user, I want failed stages to include failure metadata, so that auto-repairable, human-required, and external-required failures are distinguishable without extra top-level states.
26. As a workflow user, I want a repair inside a stage to trigger rerun of affected successful stages, so that changed code does not invalidate earlier evidence silently.
27. As a workflow author, I want stages to declare `rerun_when` triggers, so that each stage owns the conditions that make its evidence stale.
28. As a workflow user, I want dirty rerun behavior to be conservative in the MVP, so that AgentMatrix avoids skipping necessary checks.
29. As a workflow user, I want stage-level flow to be linear in the MR preflight MVP, so that the first implementation is easy to understand.
30. As a workflow user, I want stage-internal work to support safe parallelism, so that independent checks or review lanes do not run slower than necessary.
31. As a static check stage agent, I want to run read-only checks in parallel, so that lint, typecheck, security scan, and dependency scan can complete faster.
32. As a static check stage agent, I want autofix operations serialized, so that parallel writers do not corrupt the workspace.
33. As a static check stage agent, I want language-specific references for C, C++, Java, Go, Rust, JavaScript, TypeScript, Python, and Shell, so that the static gates match the changed stack.
34. As a test check stage agent, I want to discover and run repo-defined tests, so that the workflow respects existing project conventions.
35. As a test check stage agent, I want to avoid changing test expectations just to make tests pass, so that real regressions are not hidden.
36. As a code review stage agent, I want to use static and test evidence as inputs, so that review findings consider what has already passed or failed.
37. As a code review stage agent, I want independent reviewer lanes to run in parallel, so that correctness, security, maintainability, performance, data, and API risks can be assessed efficiently.
38. As a code review stage agent, I want duplicate findings merged by root cause, so that the final report is actionable.
39. As a developer preparing an MR, I want `mr_prepare` to generate only an MR title and clear description in the MVP, so that the scope stays focused.
40. As a developer preparing an MR, I want the MR description to summarize changes, validation, and notes, so that I can paste it into GitLab or GitHub manually.
41. As a product maintainer, I want MR submission, Git pushes, reviewer assignment, labels, and CI watching out of scope for MVP, so that the first release proves orchestration before external mutation.
42. As a future platform integrator, I want opencode, Claude Code, and Codex entrypoints handled outside core, so that each platform can expose AgentMatrix through its native mechanism.
43. As a future platform integrator, I want skills to remain generally portable, so that platform wrappers can expose the same core instructions where possible.
44. As a future workflow author, I want additional workflows to be added later as templates, so that AgentMatrix can grow beyond MR preflight without changing core runtime semantics.
45. As an implementer, I want the MVP to use file-system state rather than a database, so that the system is simple to inspect and test.

## Implementation Decisions

- Use TypeScript and Node.js for the CLI and runtime.
- Use YAML for workflow and config files, with JSON Schema validation for structural correctness.
- Store workflow definitions, run state, evidence, and artifacts on the file system under a project-local AgentMatrix directory.
- Do not require a database for MVP.
- Do not initialize or require git for the local project skeleton.
- Core CLI verbs are `init`, `run`, `resume`, `status`, and `visualize`.
- `run` always starts a new workflow run from the beginning.
- `resume` always continues an existing workflow run.
- `verify` is an internal runtime capability invoked after each stage, not a primary user-facing command in the MVP.
- The core model includes workflow, stage, runtime state, evidence, agent role, skill usage, verifier behavior, repair/rerun behavior, and visualization output.
- The core model does not include a cross-platform `command` abstraction. Platform-specific entrypoints live outside core.
- Platform-specific agent definitions are not normalized into one neutral agent schema. opencode and Codex can each maintain their own agent definitions, with workflow stages referencing logical `agent_role` values.
- Skills are generally portable knowledge/method packages. Platform-specific wrappers can expose them under the platform's visible skill name.
- Resource installation already exists outside this PRD. AgentMatrix checks resources before running but does not redesign or implement resource installation.
- `init` copies an internal workflow template into the project so users can edit and version it.
- MVP includes one built-in workflow: `mr-preflight`.
- `mr-preflight` contains four stages: `static_check`, `test_check`, `code_review`, and `mr_prepare`.
- Stage-to-stage execution is linear for MVP: `static_check` before `test_check`, before `code_review`, before `mr_prepare`.
- Stage-internal work can run in parallel when it is read-only and safe.
- Stage-internal writers, autofixes, snapshot updates, generated-code refreshes, and repairs must be serialized or otherwise isolated.
- Each stage has an execution agent role and a verifier agent role.
- Stage completion requires structured evidence and verifier acceptance.
- Stage statuses are `pending`, `running`, `success`, `failed`, and `skipped`.
- `failed` covers command failures, verifier failures, missing resources, human-required blockers, and external-required blockers. Details are expressed through metadata, not extra top-level states.
- `skipped` is valid only with a skip reason.
- Stage outputs are lightly strongly checked. Required inputs must exist before a stage runs, and required outputs must exist after execution.
- Key outputs use a small built-in schema set, starting with a common `stage_report` shape.
- Completion criteria use a small fixed rule set: output exists, schema valid, commands ok, no blockers, and skip reasons present.
- Repair can happen inside a stage. If repair changes files or artifacts, runtime records changed files/artifacts and marks affected successful stages pending using `rerun_when` triggers.
- Dirty rerun behavior is conservative in MVP.
- All MVP stages emit a common `stage_report` containing stage id, status, summary, commands, findings, artifacts, skipped items, and changed files.
- `static_check` uses a separate `static-check` skill focused on tool-driven checks.
- `code_review` uses a separate `industry-code-review` skill focused on dynamic reviewer lanes.
- `test_check` will have its own execution behavior, but detailed skill creation is not part of this PRD.
- `mr_prepare` only produces MR title and description in the MVP.
- The MR description only needs to clearly explain the change and validation; GitLab/GitHub API submission is out of scope.

## Testing Decisions

- Primary test seam: exercise behavior from the CLI into the AgentMatrix runtime using a temporary project directory.
- The primary seam should cover `init`, `run`, `resume`, `status`, and `visualize` from the user's perspective.
- Use mock stage executors and mock verifiers to test orchestration without depending on opencode, Codex, Claude Code, GitHub, GitLab, or real AI agents.
- Secondary test seam: focused runtime state transition tests for repair loops, dirty rerun, completion criteria, evidence validation, and stage status transitions.
- Tests should assert externally visible behavior: files created, run state transitions, evidence records, command output, visualization output, and failure messages.
- Tests should not assert implementation details such as private helper call order unless needed to pin down a bug.
- CLI tests should use temporary directories and clean fixtures.
- Workflow validation tests should cover valid workflow YAML, malformed YAML, missing required fields, unsupported status values, missing inputs, missing outputs, and invalid completion criteria.
- Runtime tests should cover `run` starting from the beginning even when previous runs exist.
- Runtime tests should cover `resume` continuing an existing run and failing clearly when no resumable run exists.
- Runtime tests should cover resource check failures before stage execution.
- Runtime tests should cover successful stage verification before advancing to the next stage.
- Runtime tests should cover verifier rejection causing a failed stage or repair loop according to stage policy.
- Runtime tests should cover repair changing files and invalidating previously successful stages via `rerun_when`.
- Visualization tests should cover Mermaid output and JSON graph output for both workflow definition and run state.
- Static check tests should cover parallel read-only gate aggregation and serialized autofix behavior through mocked commands.
- Code review tests should cover parallel reviewer lane aggregation and duplicate finding merge behavior through mocked lane reports.
- MR prepare tests should cover generation of title and description from prior stage reports without calling external MR APIs.

## Out of Scope

- Modifying opencode, Codex, or Claude Code internals.
- Implementing platform adapter packages for opencode, Codex, or Claude Code in the MVP.
- Defining a universal platform command abstraction in AgentMatrix core.
- Rebuilding or redesigning the existing resource installer.
- Automatically installing resources during `run` or `resume`.
- Creating or submitting GitLab MRs or GitHub PRs.
- Running `git push`, assigning reviewers, applying labels, or watching CI.
- Building a full graphical UI for visualization.
- Supporting arbitrary language-specific static analysis beyond C, C++, Java, Go, Rust, JavaScript, TypeScript, Python, and Shell.
- Implementing precise dependency analysis for dirty rerun in MVP.
- Creating detailed new skills for every stage before the framework skeleton exists.
- Supporting database-backed state storage.

## Further Notes

The MVP should bias toward a trustworthy, inspectable workflow engine rather than a broad platform abstraction. Conservative reruns are acceptable. Stage evidence, verifier separation, and clear run visualization are the core proof points.

The first workflow is intentionally modest: static checks, tests, code review, and MR description generation. This should be enough to validate workflow orchestration, stage completion guarantees, repair/rerun behavior, and run-state visualization before expanding into MR submission or platform-specific entrypoints.
