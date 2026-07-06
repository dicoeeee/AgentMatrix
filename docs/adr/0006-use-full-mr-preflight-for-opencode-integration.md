# Use Full MR Preflight For OpenCode Integration

The real OpenCode integration test will exercise the built-in `mr-preflight` workflow rather than a smaller synthetic workflow. This keeps the integration test aligned with the proving workflow users actually run, even though it requires more platform agent definitions and is more expensive than a smoke-only workflow. The test will use deterministic test-specific OpenCode agent templates that quickly write valid AgentMatrix evidence, so it validates OpenCode CLI integration, agent lookup, file writeback, and runtime state transitions rather than model judgment quality.

**Consequences**

The integration test must remain opt-in because it can invoke multiple real OpenCode agents and verifiers. AgentMatrix will not add arbitrary project-local workflow ID support just to make this test smaller. Full intelligent MR preflight remains a manual dogfooding concern, not an automated test requirement for this slice.
