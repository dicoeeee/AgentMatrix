# Stop new scheduling after a stage fails

When any concurrently running stage fails, AgentMatrix Core stops dispatching new stages but does not cancel stages already in flight; those stages finish and persist their evidence, dependents of the failure never start, successful independent results remain reusable, and the Run becomes failed after the active set drains. A later resume retries the failed work while preserving successful results that remain valid.
