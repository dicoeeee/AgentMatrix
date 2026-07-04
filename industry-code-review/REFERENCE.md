# General Review Reference

## Review Checklist

### Change Hygiene

- The diff is focused on one coherent change.
- Commit messages explain intent, not just touched files.
- No unrelated formatting churn unless explicitly intended.
- No debug statements, temporary flags, local paths, credentials, snapshots, or generated artifacts accidentally included.
- Public behavior changes are reflected in docs, changelog, examples, or API contracts when the repo expects them.

### Correctness

- Handles null, empty, missing, duplicate, malformed, expired, and oversized inputs.
- Handles permission denied, network failure, partial failure, retries, cancellation, and timeout.
- Preserves existing behavior for callers that do not opt into the new path.
- Avoids hidden global state, order dependence, clock dependence, and test-only assumptions.
- Uses deterministic parsing/serialization APIs instead of ad hoc string manipulation when structured data is involved.

### Tests

- Includes the smallest set of tests that would fail without the change.
- Covers at least one happy path and one important failure or edge path for non-trivial logic.
- Updates contract, snapshot, migration, UI, or integration tests if the changed surface requires it.
- Keeps tests deterministic and avoids sleeping, real network calls, wall-clock dependence, or shared mutable fixtures.
- Explains any intentionally skipped tests in the MR description.

### Security and Privacy

- Authorization is checked at the resource boundary, not only in the UI.
- User input is validated, encoded, escaped, parameterized, or rejected at the correct layer.
- Logs, analytics, traces, errors, screenshots, and fixtures do not expose secrets or personal data.
- New dependencies are necessary, maintained, license-compatible, and not duplicating existing capabilities.
- Crypto, token, session, CORS, CSP, file upload, path, and redirect behavior uses established framework APIs.
- Threat model changed if new trust boundaries, roles, external integrations, or sensitive data flows are introduced.

### Data, Compatibility, and Release

- Schema or data migrations are safe for large existing datasets and support rollback or forward recovery.
- API and event changes preserve compatibility or provide a documented migration path.
- Cache keys, background jobs, queues, workers, scheduled tasks, and persisted settings remain compatible across versions.
- Feature flags, config defaults, rollout strategy, and rollback steps are clear for risky changes.
- Observability exists for new failure modes: logs, metrics, traces, audit events, or alerts as appropriate.

### Performance and Reliability

- No obvious N+1 query, unbounded collection scan, repeated remote call, or synchronous heavy work on request paths.
- Indexes, batching, pagination, streaming, caching, and backpressure are used where data can grow.
- Retries are bounded, idempotent, and do not amplify outages.
- Resource lifecycle is explicit: files, sockets, transactions, subscriptions, timers, and goroutines/tasks are closed or cancelled.
- Failure mode degrades predictably instead of silently corrupting data or hiding errors.

### Maintainability

- Names encode domain meaning and avoid leaking implementation detail into public interfaces.
- Logic belongs in the right layer and does not bypass established helpers, validators, services, or design-system components.
- New abstraction removes real complexity or matches an existing pattern.
- Comments explain why, tradeoffs, invariants, or non-obvious constraints; they do not narrate simple code.
- The change reduces or localizes complexity instead of spreading special cases across unrelated modules.

## MR Readiness Questions

- What problem does this MR solve, and how does the diff prove it?
- What is the highest-risk line or decision in the change?
- Which reviewer/domain expert is needed for the touched area?
- What checks were run, what failed, and what was intentionally skipped?
- What should a reviewer pay special attention to?
- How would this be rolled back if it misbehaves after merge?

## Reviewer Comment Templates

### Blocking Defect

```text
blocker: This can [impact] when [condition].

Evidence: [file/line or behavior].
Suggested fix: [smallest practical change].
```

### Major Risk

```text
major: I think this path misses [case/risk].

If [condition], [bad outcome]. Could we add [fix/test] before merge?
```

### Non-Blocking Improvement

```text
non-blocking: This would be easier to maintain if [suggestion].

Not required for this MR unless you are already touching this area again.
```

### Clarifying Question

```text
question: Is [assumption] guaranteed here?

I could not find that invariant in [source]. If it is not guaranteed, [risk].
```
