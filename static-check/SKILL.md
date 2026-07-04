---
name: static-check
description: Runs tool-driven static checks for C, C++, Java, Go, Rust, JavaScript, TypeScript, Python, and Shell. Use for the static_check stage to discover repo commands, run or record formatter/lint/type/security/dependency checks, apply safe autofixes, and emit a stage_report.
---

# Static Check

Static check is mechanical preflight: discover the repo's configured gates, run check-only work in parallel where safe, serialize autofixes, then emit one stage_report.

## Steps

1. **Discover** changed stacks, package managers, CI gates, scripts, analyzer configs, and repo guidance. Complete when every touched stack maps to a supported language reference below or an explicit unsupported note.
2. **Plan gates** from repo-defined commands first, then language references. Complete when each required gate is marked check-only, autofix, skipped, or unsupported.
3. **Run check-only gates** in parallel when they do not write files or share unsafe resources. Complete when every planned check has command evidence or a skip reason.
4. **Repair safely** only when the gate is known to be autofixable. Run autofixes serially; after any file edit, rerun affected check-only gates. Complete when changed_files is exact.
5. **Report** a stage_report. Complete when commands, findings, skipped gates, artifacts, and changed_files are recorded.

## Parallelism

- Parallelize read-only checks such as lint check, typecheck, dependency audit, and security scan.
- Do not run two commands in parallel if either writes files, updates caches in the workspace, mutates snapshots, uses shared ports, or relies on global mutable state.
- Run formatter/linter autofix, import cleanup, and generated-code refresh serially.
- If a repair edits code, rerun the static gates affected by those files before reporting success.

## Supported Languages

Read only the relevant language reference:

- [C](references/c.md)
- [C++](references/cpp.md)
- [Java](references/java.md)
- [Go](references/go.md)
- [Rust](references/rust.md)
- [JavaScript](references/javascript.md)
- [TypeScript](references/typescript.md)
- [Python](references/python.md)
- [Shell](references/shell.md)

For other languages, mark static-analysis coverage unsupported and report the gap.

## Output

Emit one `stage_report` using [REFERENCE.md](REFERENCE.md). Findings from failed gates use severity `blocker` when they block merge readiness; skipped gates must include reasons.
