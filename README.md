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

`agentmatrix init` creates a project-local `.agentmatrix/` directory with workflow templates, run state, and artifact directories. It does not initialize or require git in the target project. `agentmatrix run` creates a fresh run every time; `resume`, `status`, and `visualize` operate on the filesystem-backed run state.
