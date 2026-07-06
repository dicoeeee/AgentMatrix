# Platform Init Merges Available Resources

When a user runs platform initialization, AgentMatrix will merge the selected workflow's required resources into `.agentmatrix/config.json` without deleting or overwriting existing resource declarations. This keeps `init --platform opencode` as a complete setup step for the selected workflow while preserving the distinction between AgentMatrix available resources and OpenCode agent definitions.

**Considered Options**

- Leave `.agentmatrix/config.json` unchanged during platform initialization.
- Overwrite `availableResources` from the workflow.
- Merge missing workflow resources while preserving existing entries.

**Consequences**

Users can run platform initialization on an older project and avoid a later core resource-check failure, while custom resource declarations remain intact. The `--force` option still only controls platform template overwrite behavior and does not change the config merge semantics.
