# Schedule all ready stages from the workflow DAG

`depends_on` defines the Workflow's complete partial order: every pending stage whose dependencies succeeded is a Ready Stage, all Ready Stages are eligible to run concurrently, and a stage depending on multiple predecessors is their join. YAML list order has no execution meaning, so AgentMatrix Core must validate the graph for cycles and unknown dependencies, schedule ready sets rather than the first incomplete stage, and persist each concurrent transition independently.
