# Explicit Platform Agent Template Installation

AgentMatrix keeps the default project skeleton platform-neutral, so platform agent templates are installed only when the user explicitly selects a platform during initialization. OpenCode support will use `agentmatrix init --platform opencode` to generate OpenCode agent templates, rather than writing `.opencode/` files by default or adding a separate installer command.

**Considered Options**

- Install OpenCode templates by default during `init`.
- Add a separate OpenCode template installer command.
- Install templates through an explicit `init --platform opencode` option.

**Consequences**

The initialization path remains the single project setup entrypoint, while platform-specific files are created only by explicit user choice. Future platforms can follow the same `--platform` shape without changing the workflow model.
