# Enforce workspace read-write scheduling in Core

Every generated Workflow stage declares Workspace Access as `read` or `write`. AgentMatrix Core enforces a logical read-write lock when dispatching Ready Stages: multiple readers may run concurrently, while a writer runs alone without concurrent readers or writers; Stage prompts repeat the access contract for agent behavior but are not the enforcement mechanism, and the MVP does not require an operating-system file lock.
