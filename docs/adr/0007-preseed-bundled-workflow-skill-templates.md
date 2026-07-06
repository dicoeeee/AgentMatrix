# Preseed Bundled Workflow Skill Templates

AgentMatrix initialization will copy bundled skill templates required by the selected workflow into `.agentmatrix/skills/<skill>/`. Existing local skill directories are preserved, and unknown workflow skills are reported as unavailable rather than treated as initialization failures.

**Considered Options**

- Keep `init` limited to workflow/config skeleton files and require a separate skill installer.
- Copy full skill instructions into platform agent templates.
- Preseed bundled skill directories under `.agentmatrix/skills/` and keep platform agent templates thin.

**Consequences**

The `mr-preflight` workflow can be initialized with its portable skill instructions already present in the target project, while `run` and `resume` remain execution-only and do not install resources. Platform agent templates can point agents at the project-local skill paths without duplicating long instructions or changing platform-specific agent definition ownership.
