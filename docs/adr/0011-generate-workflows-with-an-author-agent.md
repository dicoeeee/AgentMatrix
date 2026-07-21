# Generate workflows with an author agent

A Workflow Author Agent will translate user intent and repository context into a candidate Workflow definition, while AgentMatrix Core remains responsible for deterministic schema, graph, resource, and execution validation before a Run can start. Scenario-specific behavior belongs in generated Workflow stages, agent roles, skills, and completion contracts rather than in orchestration Core, so `mr-preflight` remains a proving example instead of defining constraints for unrelated workflows.
