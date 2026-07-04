# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This repo uses a single-context layout:

- `CONTEXT.md` at the repo root
- `docs/adr/` for architecture decision records

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists.
- ADRs under `docs/adr/` that touch the area you're about to work in.

If these files do not exist, proceed silently. The domain-modeling flow creates them lazily when terms or architectural decisions are resolved.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept you need is not in the glossary yet, note it for domain modeling.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
