# AgentMatrix

AgentMatrix coordinates AI coding agents through explicit workflow stages, evidence, verification, and resumable run state.

## Language

**Workflow**:
A human-reviewable definition of the engineering process AgentMatrix coordinates.
_Avoid_: Script, command list

**Workflow Author Agent**:
An agent role that turns user intent and repository context into a candidate Workflow definition, including stage decomposition and concurrency opportunities, for AgentMatrix Core to validate.
_Avoid_: Run Driver, workflow scheduler

**Workflow Snapshot**:
The immutable Workflow definition and content identity captured when a Run starts and used for every later resume of that Run.
_Avoid_: Editable workflow file, latest workflow version

**Ready Stage**:
A pending Workflow stage whose declared dependencies have all completed successfully and is therefore eligible for scheduling.
_Avoid_: Next stage, first pending stage

**Workspace Access**:
A stage declaration of `read` or `write` access to the shared project workspace. Read stages may run concurrently, while a write stage requires exclusive scheduling by AgentMatrix Core.
_Avoid_: Prompt-only restriction, operating-system file lock

**Run**:
A single execution of a workflow, with its own state, events, evidence, and artifacts.
_Avoid_: Session

**Run Driver**:
The user-facing controller that advances a run through workflow stages while AgentMatrix remains authoritative for run state, evidence, and verification.
_Avoid_: CLI runner, session driver

**Run Trace**:
An append-only structured record of observable execution milestones for one run, used as a visualization index.
It records stage boundaries, agent/subagent activity summaries, command or script summaries, executor outcomes, verifier checks, final decisions, and links to detailed logs or evidence.
It does not expose hidden model reasoning.
_Avoid_: Console log, transcript, hidden chain-of-thought, full audit log, visualization cache

**Stage Log**:
A per-stage, per-role detailed log for executor, verifier, or child subagent activity.
Run Trace events may link to stage logs, but logs are not workflow state and are not the primary visualization model.
_Avoid_: Run trace, run state, verifier evidence

**Run Detail View**:
An HTML visualization of one run that reads Run Trace, run state, stage reports, evidence, and Stage Log links to show the stage flow and per-stage execution details.
_Avoid_: Mermaid graph, terminal verbose output, log file

**Driver Protocol**:
The deterministic command contract a run driver uses to inspect and advance a run without owning workflow state-machine decisions.
_Avoid_: Agent API, orchestration API

**Stage Invocation**:
A driver-facing instruction packet that names the workflow stage, the platform role to invoke, the prompt/context to pass, and the evidence paths AgentMatrix expects afterward.
_Avoid_: Prompt, command wrapper

**Change Scope**:
The set of files and diff context a run is expected to validate for MR readiness.
_Avoid_: Whole project, workspace scan

**Change Coverage**:
Evidence that every file in a change scope is accounted for by executed checks, skipped checks, or unsupported-analysis reasons.
_Avoid_: Sampled check, partial scan

**Check Shard**:
A subset of a large change scope assigned to one checker subagent for focused static analysis.
_Avoid_: Random sample, partial coverage

**Runtime Adapter**:
A platform integration that turns a workflow stage into execution by a concrete agent system while preserving AgentMatrix workflow semantics.
_Avoid_: Backend, executor

**Platform Agent Template**:
A project-local agent definition generated for a supported agent platform so logical workflow roles can be executed by that platform.
_Avoid_: Built-in agent, workflow stage

**Platform Agent Definition**:
A concrete agent configuration that a supported agent platform can invoke for a logical workflow role.
_Avoid_: Resource, runtime adapter

**Available Resource**:
A project-local declaration that a logical workflow dependency is available to AgentMatrix before a run starts.
_Avoid_: OpenCode agent definition, installed file

**Bundled Skill Template**:
A portable skill instruction directory shipped with AgentMatrix and copied into a project during initialization when the selected workflow declares that skill.
_Avoid_: Available resource, platform agent template

**Opt-In Integration Test**:
A test that exercises an external agent platform or service only when explicitly enabled by the developer.
_Avoid_: Unit test, default CI test
