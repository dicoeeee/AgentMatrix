# TypeScript Static Check Reference

## Detect

- `.ts`, `.tsx`, `tsconfig*.json`, typed package exports, workspace config, ESLint/Prettier/Biome configs, frontend or Node framework configs.

## Gates

- If no repo script covers the gate, consider formatter check, ESLint/Biome, `tsc --noEmit`, framework lint/build, dependency audit, unused export/dead code checks.
- For public packages, check generated declarations, export maps, and backwards-compatible types.

## Safe Repair

- Formatter, lint autofix, and import cleanup are safe when repo tooling supports them.
- Do not paper over type errors with `any`, unchecked casts, or ignored diagnostics.
