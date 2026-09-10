import type { ToolDefinition } from "./types.js";
import { createMockTicket } from "./mockData.js";

interface CreateSupportTicketArgs {
  orderId?: string;
  reason: string;
  description: string;
}

// operationType: "write" is what makes this tool different at the agent-loop
// level - see apps/api/src/agent/agentLoop.ts. This handler itself has no
// idea it's being gated; the trust boundary lives entirely in the loop.
export const createSupportTicketTool: ToolDefinition<CreateSupportTicketArgs> = {
  name: "createSupportTicket",
  description:
    "Create a support ticket for an issue the assistant cannot resolve itself (e.g. a missing package, a damaged item, a billing dispute). This performs a real write action and must only be called after the user has explicitly confirmed they want the ticket created.",
  operationType: "write",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The related order ID, if there is one." },
      reason: { type: "string", description: 'Short category for the issue, e.g. "package not delivered", "damaged item".' },
      description: { type: "string", description: "A clear description of the problem, written from what the user told you." },
    },
    required: ["reason", "description"],
  },
  validate(args) {
    if (typeof args !== "object" || args === null) {
      return { valid: false, error: "Arguments must be an object." };
    }
    const { orderId, reason, description } = args as Record<string, unknown>;
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return { valid: false, error: "reason is required and must be a non-empty string." };
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      return { valid: false, error: "description is required and must be a non-empty string." };
    }
    if (orderId !== undefined && (typeof orderId !== "string" || orderId.trim().length === 0)) {
      return { valid: false, error: "orderId, if provided, must be a non-empty string." };
    }
    return {
      valid: true,
      value: {
        orderId: orderId ? (orderId as string).trim() : undefined,
        reason: reason.trim(),
        description: description.trim(),
      },
    };
  },
  async handler(args) {
    const ticket = createMockTicket(args);
    return { success: true, data: ticket };
  },
};
