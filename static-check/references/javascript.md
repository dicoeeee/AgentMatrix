# JavaScript Static Check Reference

## Detect

- `.js`, `.mjs`, `.cjs`, `package.json`, lockfiles, workspace config, ESLint/Prettier/Biome configs, frontend or Node framework configs.

## Gates

- If no repo script covers the gate, consider formatter check, ESLint/Biome, framework lint/build, dependency audit, unused export/dead code checks.
- For UI changes, include accessibility or component static checks when the repo has them.

## Safe Repair

- Formatter, lint autofix, and import cleanup are safe when repo tooling supports them.
- Do not auto-change async behavior, runtime validation, auth checks, or browser/server boundaries.
