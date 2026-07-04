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

`agentmatrix init --workflow mr-preflight` creates a project-local `.agentmatrix/` directory with workflow templates, run state, and artifact directories. It does not initialize or require git in the target project. `agentmatrix run` creates a fresh run every time; `resume`, `status`, and `visualize` operate on the filesystem-backed run state.

The copied `mr-preflight` workflow is editable YAML. Its four linear stages are `static_check`, `test_check`, `code_review`, and `mr_prepare`; each stage declares inputs, outputs, completion criteria, repair policy, rerun triggers, execution and verifier roles, and any platform-visible skills. The core workflow template does not define platform-specific agent files or a cross-platform command abstraction.

Workflow YAML is validated before run/resume paths use it. Validation errors include the workflow file location and the specific field path that needs attention.
