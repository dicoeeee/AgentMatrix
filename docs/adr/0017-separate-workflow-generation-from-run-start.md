# Separate Workflow generation from Run start

The Workflow Author Agent writes a candidate definition that AgentMatrix Core validates and saves for human review, but generation does not implicitly execute it. A user's explicit `run` action approves the current definition, captures its Workflow Snapshot, and begins scheduling without requiring additional confirmation at every stage.
