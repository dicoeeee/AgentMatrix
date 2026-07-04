# Go Static Check Reference

## Detect

- `go.mod`, `go.work`, `.golangci.yml`, Makefiles, Taskfiles, CI jobs, protobuf/OpenAPI generation.

## Gates

- If no repo command covers the gate, consider `gofmt`, `go vet`, `go test ./...` for compile/static coverage, race tests for concurrent code, Staticcheck/golangci-lint, `govulncheck`.
- For libraries, include public API compatibility checks if the repo has them.

## Safe Repair

- `gofmt`, `goimports`, and generated-code refresh are safe when repo tooling expects them.
- Do not rewrite context, goroutine, channel, error, or API behavior as a static autofix.
