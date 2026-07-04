# Shell Static Check Reference

## Detect

- `.sh`, Bash/Zsh scripts, shebang scripts, Makefile shell fragments, CI shell steps, install/deploy/release scripts, ShellCheck or shfmt configs.

## Gates

- If no repo command covers the gate, consider `shellcheck`, `shfmt -d`, Bats compile/smoke checks, and dry-run modes for deploy/release scripts.
- Match the declared shell from the shebang; do not apply Bash-only assumptions to POSIX `sh`.

## Safe Repair

- `shfmt` formatting is safe when repo tooling expects it.
- Do not auto-change quoting, control flow, destructive commands, credentials, or deploy behavior without explicit review.
