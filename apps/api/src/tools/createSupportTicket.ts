import type { ToolDefinition } from "./types.js";
import { fetchOrder, createTicket } from "../services/orderServiceClient.js";

interface CreateSupportTicketArgs {
  orderId: string;
  reason: string;
  description: string;
}

// operationType: "write" is what makes this tool different at the agent-loop
// level - see apps/api/src/agent/agentLoop.ts. This handler itself has no
// idea it's being gated; the trust boundary lives entirely in the loop.
export const createSupportTicketTool: ToolDefinition<CreateSupportTicketArgs> = {
  name: "createSupportTicket",
  description:
    "Create a support ticket for an issue the assistant cannot resolve itself (e.g. a missing package, a damaged item, a billing dispute). Requires an order ID, since the ticket must be tied to the customer who owns that order. This performs a real write action and must only be called after the user has explicitly confirmed they want the ticket created.",
  operationType: "write",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The related order ID. Required - ask the user for it if it isn't already in the conversation." },
      reason: { type: "string", description: 'Short category for the issue, e.g. "package not delivered", "damaged item".' },
      description: { type: "string", description: "A clear description of the problem, written from what the user told you." },
    },
    required: ["orderId", "reason", "description"],
  },
  validate(args) {
    if (typeof args !== "object" || args === null) {
      return { valid: false, error: "Arguments must be an object." };
    }
    const { orderId, reason, description } = args as Record<string, unknown>;
    if (typeof orderId !== "string" || orderId.trim().length === 0) {
      return { valid: false, error: "orderId is required and must be a non-empty string." };
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      return { valid: false, error: "reason is required and must be a non-empty string." };
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      return { valid: false, error: "description is required and must be a non-empty string." };
    }
    return {
      valid: true,
      value: { orderId: orderId.trim(), reason: reason.trim(), description: description.trim() },
    };
  },
  async handler({ orderId, reason, description }) {
    const orderResult = await fetchOrder(orderId);
    if (!orderResult.ok) {
      if (orderResult.status === 404) {
        return { success: false, error: `No order found with ID "${orderId}"; cannot file a ticket against it.` };
      }
      return { success: false, error: "Could not look up the order to file this ticket. Please try again shortly." };
    }

    const result = await createTicket({ orderId, customerId: orderResult.data.customerId, reason, description });
    if (!result.ok) {
      return { success: false, error: "Could not create the support ticket right now. Please try again shortly." };
    }
    return { success: true, data: result.data };
  },
};
