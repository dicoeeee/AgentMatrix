# AgentMatrix

AgentMatrix is a workflow orchestration kit for AI coding agents.

The MVP focuses on a portable workflow runtime and a concrete `mr-preflight` workflow that helps move from completed code to MR-ready output with structured evidence, verification, repair/rerun handling, and visualization.

## Local CLI

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Run the local command through Node:

```sh
node dist/cli.js --help
```

Supported MVP verbs are `init`, `run`, `resume`, `status`, and `visualize`.

`agentmatrix init --workflow mr-preflight` creates a project-local `.agentmatrix/` directory with workflow templates, workflow-declared bundled skill templates, run state, and artifact directories. It does not initialize or require git in the target project. Bundled skill templates are copied to `.agentmatrix/skills/<skill>/` when the workflow declares them, and existing local skill directories are preserved. `agentmatrix run` creates a fresh run every time and executes the built-in workflow with static-check, test-check, code-review, and MR-prepare mock adapters by default, plus mock verifier agents; `resume`, `status`, and `visualize` operate on the filesystem-backed run state. `agentmatrix visualize --workflow mr-preflight` renders the static workflow definition, while `agentmatrix visualize [run-id]` renders actual run state. Both targets support `--format mermaid|json`. Run visualizations also surface stage-internal parallel activity from stage report `parallel_group` commands and OpenCode background subagents recorded in executor evidence. Mermaid output remains on stdout; when stdout is an interactive terminal, AgentMatrix also writes `.agentmatrix/visualizations/*.html` with an enhanced browser layout and opens it in the default browser. Use `--no-open` to suppress that behavior, or `--open` to force HTML generation and browser opening when stdout is piped.

Use OpenCode as the runtime adapter with:

```sh
node dist/cli.js run --runtime opencode
```

`run` and `resume` also accept `--opencode-bin <path>`, `--opencode-model <provider/model>`, `--opencode-attach <url>`, and `--opencode-auto` when `--runtime opencode` is selected. The OpenCode adapter invokes `opencode run --agent <role> --dir <project> --format json` for each execution and verifier role declared by the workflow. Execution agents are expected to write the declared stage outputs, including `stage_report`; verifier agents are expected to write verifier evidence with an `accepted` boolean.

Pass `--verbose` to `run` or `resume` to print runtime command details. For OpenCode runs, verbose output includes each executor and verifier invocation, the redacted command, exit code, stdout, and stderr.

The copied `mr-preflight` workflow is editable YAML. Its four linear stages are `static_check`, `test_check`, `code_review`, and `mr_prepare`; each stage declares inputs, outputs, completion criteria, repair policy, rerun triggers, execution and verifier roles, and any platform-visible skills. The core workflow template does not define platform-specific agent files or a cross-platform command abstraction; static and test commands are discovered by, or injected into, the runtime adapter rather than stored in workflow YAML.

Workflow YAML is validated before run/resume paths use it. Validation errors include the workflow file location and the specific field path that needs attention.

`run` and `resume` also check required resources before changing run state. Required agent roles, skills, and MCP resources are derived from the workflow, and the default project-local provider reads `.agentmatrix/config.json` `availableResources`. Missing resources fail early with a message naming the missing items and pointing users toward the existing installer capability; `run` and `resume` do not auto-install resources. Project setup remains explicit through `agentmatrix init`, which pre-seeds bundled skill templates for the selected workflow.

## Testing

The default test suite is offline and deterministic:

```sh
npm test
```

It does not require OpenCode or any configured model provider.

To run the opt-in real OpenCode integration test, install and configure the `opencode` CLI locally, then run:

```sh
AGENTMATRIX_OPENCODE_INTEGRATION=1 npm run test:opencode
```

The integration test creates a temporary project, initializes the full `mr-preflight` workflow, writes deterministic test-only OpenCode agent templates for every execution and verifier role, and runs the real `opencode run` path through `agentmatrix run --runtime opencode`. It validates agent lookup, OpenCode CLI invocation, file writeback, and AgentMatrix run-state transitions.

Optional environment variables:

- `AGENTMATRIX_OPENCODE_BIN`: OpenCode executable path, default `opencode`.
- `AGENTMATRIX_OPENCODE_MODEL`: provider/model value passed to `--opencode-model`.
- `AGENTMATRIX_OPENCODE_ATTACH`: URL passed to `--opencode-attach`.
- `AGENTMATRIX_OPENCODE_AUTO=0`: omit `--opencode-auto`; by default the integration test passes `--opencode-auto` inside the temporary project.
- `AGENTMATRIX_OPENCODE_INTEGRATION_TIMEOUT_MS`: test and CLI timeout, default 20 minutes.
