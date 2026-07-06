# Keep Platform Agent Templates Thin

Platform agent templates should describe the platform-facing role, permissions, and output contract, but should not duplicate full AgentMatrix skill instructions. The AgentMatrix runtime passes dynamic stage context to the platform agent, and the workflow plus shared skill/reference files remain the durable source of truth for stage semantics.

**Consequences**

Generated OpenCode templates are easier to keep current and can stay stable while workflow paths, run IDs, and artifact locations vary per run. If a stage needs deeper instructions, the template should point the agent at the relevant project files instead of copying those instructions into the generated template.
