import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition } from "./types.js";
import { getOrderTool } from "./getOrder.js";
import { checkReturnEligibilityTool } from "./checkReturnEligibility.js";
import { createSupportTicketTool } from "./createSupportTicket.js";

// The ONLY tools Claude can ever cause to run. Claude sees the `name` and
// `inputSchema` of everything here (via toAnthropicTools) and can ask to call
// them by name - but "ask to call by name" is as far as it goes. Nothing in
// this codebase lets Claude execute a name that isn't a key of this map, so
// there's no way for it to invent or reach an arbitrary function.
const registry = new Map<string, ToolDefinition>([
  [getOrderTool.name, getOrderTool],
  [checkReturnEligibilityTool.name, checkReturnEligibilityTool],
  [createSupportTicketTool.name, createSupportTicketTool],
]);

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return [...registry.values()];
}

export function toAnthropicTools(): Anthropic.Tool[] {
  return getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
