# Validate OpenCode Agent Definitions Before Execution

OpenCode runtime execution will fail before AgentMatrix creates or mutates run state unless every workflow execution role and verifier role resolves to an OpenCode agent definition. The validator accepts both project-local Markdown agents and `opencode.json` agent entries, because both are supported OpenCode configuration shapes and users may already have one of them.

**Consequences**

OpenCode setup errors stay in the same early-failure category as missing AgentMatrix resources, but the concerns remain separate: AgentMatrix resources say which logical roles and skills the workflow requires, while OpenCode agent definitions prove that the selected platform can invoke those roles.
