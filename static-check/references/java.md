# Java Static Check Reference

## Detect

- `.java`, `pom.xml`, `build.gradle*`, `settings.gradle*`, `gradle.properties`, Checkstyle/PMD/SpotBugs/Error Prone configs.

## Gates

- If Maven/Gradle tasks do not cover the gate, consider Checkstyle, PMD, SpotBugs, Error Prone, dependency vulnerability checks, and generated-code/schema checks.
- Include OpenAPI, protobuf, GraphQL, or database codegen verification when generated contracts are touched.

## Safe Repair

- Formatting/import ordering may be auto-applied when repo tooling supports it.
- Do not change transaction, nullability, concurrency, serialization, or public API behavior as a static autofix.
