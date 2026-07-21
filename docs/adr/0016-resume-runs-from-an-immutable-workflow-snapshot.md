# Resume Runs from an immutable Workflow Snapshot

Starting a Run captures the complete validated Workflow definition and its content hash as an immutable Workflow Snapshot owned by that Run. Resume always uses this snapshot rather than the latest editable project Workflow, so changing a generated YAML definition requires a new Run and workflow migration remains outside the current execution contract.
