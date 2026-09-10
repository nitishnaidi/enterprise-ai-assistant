import type Anthropic from "@anthropic-ai/sdk";

// Set by us when a tool is registered, never by Claude. The agent loop reads
// this to decide whether a validated call may execute immediately (read) or
// must stop and wait for an explicit user confirmation round-trip (write).
export type OperationType = "read" | "write";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type ValidationResult<TArgs> =
  | { valid: true; value: TArgs }
  | { valid: false; error: string };

export interface ToolDefinition<TArgs = any> {
  name: string;
  description: string;
  operationType: OperationType;
  /** Sent to Claude verbatim so it knows what arguments to produce. */
  inputSchema: Anthropic.Tool.InputSchema;
  /** Backend-side check of whatever Claude actually sent - never trust `inputSchema` alone. */
  validate: (args: unknown) => ValidationResult<TArgs>;
  handler: (args: TArgs) => Promise<ToolResult>;
}
