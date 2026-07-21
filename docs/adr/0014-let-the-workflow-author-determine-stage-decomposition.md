# Let the Workflow Author determine stage decomposition

AgentMatrix Core will not impose a fixed parallel-stage limit or inspect code volume to decide decomposition. The Workflow Author Agent uses user intent, repository context, task size, and safe independence to generate the appropriate number of stages, after which Core dispatches all Ready read stages and applies only dependency and Workspace Access constraints; temporary platform capacity is handled by the Runtime Adapter without changing Workflow semantics.
