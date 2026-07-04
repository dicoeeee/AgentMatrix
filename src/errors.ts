export class AgentMatrixError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "AgentMatrixError";
    this.exitCode = exitCode;
  }
}

export class CliUsageError extends AgentMatrixError {
  constructor(message: string) {
    super(message, 2);
    this.name = "CliUsageError";
  }
}
