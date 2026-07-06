# Force Controls Platform Template Overwrite

Platform agent template installation will not overwrite existing files by default. A user can pass `--force` during platform template installation to overwrite existing platform agent template files completely; AgentMatrix will not add a managed marker to frontmatter for this slice. The `--force` option applies only to platform agent templates and does not overwrite `.agentmatrix` workflow or config files.

**Considered Options**

- Add an `agentmatrix_managed` frontmatter marker and only overwrite marked files.
- Use a simple `--force` option that overwrites existing platform template files.

**Consequences**

The CLI remains simpler and avoids introducing template ownership metadata before it is needed. Users must treat `--force` as destructive for existing platform templates.
