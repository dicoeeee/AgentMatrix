# AgentMatrix

AgentMatrix coordinates AI coding agents through explicit workflow stages, evidence, verification, and resumable run state.

## Language

**Workflow**:
A human-reviewable definition of the engineering process AgentMatrix coordinates.
_Avoid_: Script, command list

**Run**:
A single execution of a workflow, with its own state, events, evidence, and artifacts.
_Avoid_: Session

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
