import type { AnySchema } from "ajv";

import { BUILT_IN_SCHEMAS, COMPLETION_CRITERION_TYPES, RERUN_TRIGGER_TYPES } from "./workflow-constants.js";

export const WORKFLOW_SCHEMA: AnySchema = {
  type: "object",
  required: ["schema_version", "id", "name", "stages"],
  additionalProperties: false,
  properties: {
    schema_version: {
      type: "integer"
    },
    id: {
      type: "string",
      minLength: 1
    },
    name: {
      type: "string",
      minLength: 1
    },
    description: {
      type: "string"
    },
    stages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "id",
          "depends_on",
          "inputs",
          "outputs",
          "completion_criteria",
          "repair_policy",
          "rerun_when",
          "agent_role",
          "verifier_role",
          "skills"
        ],
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            minLength: 1
          },
          name: {
            type: "string"
          },
          depends_on: {
            type: "array",
            items: {
              type: "string",
              minLength: 1
            }
          },
          inputs: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "required"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  minLength: 1
                },
                required: {
                  type: "boolean"
                },
                source_stage: {
                  type: "string",
                  minLength: 1
                },
                output: {
                  type: "string",
                  minLength: 1
                }
              }
            }
          },
          outputs: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "path", "required"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  minLength: 1
                },
                path: {
                  type: "string",
                  minLength: 1
                },
                required: {
                  type: "boolean"
                },
                schema: {
                  type: "string",
                  enum: [...BUILT_IN_SCHEMAS]
                }
              }
            }
          },
          completion_criteria: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["type"],
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: [...COMPLETION_CRITERION_TYPES]
                },
                output: {
                  type: "string",
                  minLength: 1
                },
                schema: {
                  type: "string",
                  enum: [...BUILT_IN_SCHEMAS]
                }
              }
            }
          },
          repair_policy: {
            type: "object",
            required: ["allow_repair", "max_attempts", "writes_allowed"],
            additionalProperties: false,
            properties: {
              allow_repair: {
                type: "boolean"
              },
              max_attempts: {
                type: "integer",
                minimum: 0
              },
              writes_allowed: {
                type: "boolean"
              }
            }
          },
          rerun_when: {
            type: "array",
            items: {
              type: "object",
              required: ["type"],
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: [...RERUN_TRIGGER_TYPES]
                },
                paths: {
                  type: "array",
                  items: {
                    type: "string",
                    minLength: 1
                  }
                },
                artifacts: {
                  type: "array",
                  items: {
                    type: "string",
                    minLength: 1
                  }
                }
              },
              allOf: [
                {
                  if: {
                    properties: {
                      type: {
                        const: "changed_files"
                      }
                    }
                  },
                  then: {
                    required: ["paths"],
                    properties: {
                      paths: {
                        minItems: 1
                      }
                    }
                  }
                },
                {
                  if: {
                    properties: {
                      type: {
                        const: "changed_artifacts"
                      }
                    }
                  },
                  then: {
                    required: ["artifacts"],
                    properties: {
                      artifacts: {
                        minItems: 1
                      }
                    }
                  }
                }
              ]
            }
          },
          mcp_resources: {
            type: "array",
            items: {
              type: "string",
              minLength: 1
            }
          },
          agent_role: {
            type: "string",
            minLength: 1
          },
          verifier_role: {
            type: "string",
            minLength: 1
          },
          skills: {
            type: "array",
            items: {
              type: "string"
            }
          }
        }
      }
    }
  }
};
