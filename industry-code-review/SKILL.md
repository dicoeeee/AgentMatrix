---
name: industry-code-review
description: Reviews code changes before MR/PR submission using dynamic reviewer lanes for correctness, tests, security, data, performance, maintainability, and product/API risk. Use for the code_review stage after static_check and test_check evidence exists.
---

# Industry Code Review

Dynamic review means the same control loop every run, not the same checklist: read the diff and existing evidence, route into reviewer lanes, expand when new risk appears, then converge on merge readiness.

## Dynamic Workflow

1. **Snapshot** the review context: read the diff, commit list, changed files, static_check report, test_check report, and local review guidance. Complete when you can state the change intent, touched runtime paths, public interfaces, data/config changes, and evidence already available.
2. **Route** into reviewer lanes: classify risk as low, medium, high, or release-blocking. Complete when every review lane below is selected, skipped with reason, or deferred because another lane must inspect first.
3. **Inspect** selected lanes. Independent lanes may run in parallel; each lane must report findings or an explicit no-issue judgement. Complete when selected lanes produce evidence with file/line anchors where relevant.
4. **Expand** on risk signals: if a lane finds security, data, migration, concurrency, API, release, or performance risk, add the matching lane and read [Dynamic Routing](references/dynamic-routing.md). Complete when no unexamined risk signal points to another lane.
5. **Converge** in stage_report form: findings first, then skipped lanes, test gaps, open questions, and a short summary. Complete when every blocker or major risk has file/line evidence, impact, and the smallest practical fix.

## Reviewer Lanes

- Scope hygiene
- Correctness
- Test adequacy
- Static/test evidence gaps
- Security and privacy
- Data, compatibility, and release
- Performance and reliability
- Maintainability
- Product/API/UX impact

## Parallelism

- Run independent reviewer lanes in parallel when their inputs are read-only.
- Do not let parallel lanes edit files. If review policy allows repairs, serialize the repair after findings are merged and record changed_files in the stage_report.
- Merge duplicate findings by root cause before reporting.

## Output Format

- Produce a stage_report with findings first, ordered by severity.
- Each finding includes severity, file/line when applicable, problem, impact, and recommended fix.
- Include skipped lanes, test gaps, open questions, artifacts, and changed_files.
- Mark non-blocking suggestions clearly so they do not masquerade as defects.

## Severity

- **Blocker**: likely production incident, security/privacy issue, data loss/corruption, broken build, migration hazard, or impossible rollback.
- **Major**: likely user-visible bug, important regression, missing critical test, serious maintainability or performance risk.
- **Minor**: localized defect, unclear behavior, small test/documentation gap, or low-risk cleanup.
- **Nit**: style or readability preference that should not block review.

## Deeper Checklist

Use [REFERENCE.md](REFERENCE.md) when the review is medium/high risk, spans security/data/release behavior, or needs reviewer comment templates.
Use [Dynamic Routing](references/dynamic-routing.md) when routing is ambiguous, the diff spans multiple stacks, or one lane reveals another risk.
