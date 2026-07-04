# Rust Static Check Reference

## Detect

- `Cargo.toml`, `Cargo.lock`, workspace config, `rust-toolchain.toml`, `.cargo/config.toml`, Rustfmt/Clippy configs.

## Gates

- If no repo command covers the gate, consider `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test --no-run` for compile/static coverage, feature-matrix checks, `cargo audit` or dependency policy checks.
- For libraries, inspect public API, features, semver, docs, and examples.

## Safe Repair

- `cargo fmt` is safe when formatting is expected.
- Do not auto-change `unsafe`, panic behavior, trait bounds, feature flags, or public API behavior.
