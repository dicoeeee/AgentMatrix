# Dynamic Review Routing Reference

Use this reference to turn a diff and existing static/test evidence into reviewer lanes. Do not run every lane by default; open the lane when its trigger appears, and stop only when no trigger remains unresolved.

## Control Loop

1. Build a snapshot: changed files, commits, intended behavior, repo commands, CI gates, owners, templates.
2. Choose initial lanes from public interfaces, data/config changes, static/test evidence, and user request.
3. Inspect selected lanes; run independent read-only lanes in parallel when useful.
4. Inspect lane findings for secondary triggers.
5. Add secondary lanes until each trigger is either reviewed, explicitly irrelevant, or blocked by missing context.

## Lane Triggers

- **Scope hygiene**: large diff, unrelated files, generated files, formatting churn, debug output, secrets, local paths.
- **Correctness**: changed control flow, parsing, state transition, error handling, time/date, numeric logic, retries, idempotency.
- **Static/test evidence gaps**: missing static_check/test_check report, failed command, skipped gate without reason, unsupported language, stale evidence after repair.
- **Test adequacy**: behavior change, bugfix, regression risk, new branch, changed contract, missing failing test for the claimed fix.
- **Security and privacy**: authn/authz, user input, file/network/shell boundaries, secrets, PII, crypto/session/CORS/CSP, dependency changes.
- **Data and release**: schema migration, backfill, cache key, queue/job, event shape, API contract, config default, feature flag.
- **Performance and reliability**: loops over growing data, remote calls, concurrency, locks, resource lifecycle, timeouts, retries, observability.
- **Maintainability**: new abstraction, cross-module coupling, duplicated shape, ownership boundary, dependency direction, complex branch.
- **Product/API/UX**: user-visible flow, copy, accessibility, screenshots, telemetry, docs, public API compatibility.

## Escalation Rules

- Any security, privacy, data-loss, migration, broken-build, or impossible-rollback issue is at least **Blocker** until disproven.
- Any unrun gate that normally protects the changed path must be reported as skipped evidence, not silently ignored.
- If a lane depends on unavailable context, report the missing context and review the remaining lanes; do not block the whole preflight unless the missing context controls merge safety.

## Convergence Test

The dynamic review is complete only when:

- static_check and test_check evidence covers every changed stack, or each gap is recorded as a finding/skipped lane;
- every selected lane has findings, skipped evidence, or a manual no-issue judgement;
- every secondary trigger discovered during inspection was either reviewed or recorded as unresolved;
- every Blocker/Major finding has file/line evidence, impact, and smallest practical fix.
