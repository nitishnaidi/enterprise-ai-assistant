import type { ToolDefinition } from "./types.js";
import { fetchReturnEligibility } from "../services/orderServiceClient.js";

interface CheckReturnEligibilityArgs {
  orderId: string;
  itemId?: string;
}

export const checkReturnEligibilityTool: ToolDefinition<CheckReturnEligibilityArgs> = {
  name: "checkReturnEligibility",
  description:
    "Determine whether an order (or a specific item in it) is eligible for return, by combining live order data with return-policy rules (30-day window, non-returnable categories). Use this instead of guessing from the policy text alone when a specific order is involved.",
  operationType: "read",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: 'The order ID, e.g. "ORD-123".' },
      itemId: {
        type: "string",
        description: "Optional. A specific item ID within the order, if the user is asking about one item rather than the whole order.",
      },
    },
    required: ["orderId"],
  },
  validate(args) {
    if (typeof args !== "object" || args === null) {
      return { valid: false, error: "Arguments must be an object." };
    }
    const { orderId, itemId } = args as Record<string, unknown>;
    if (typeof orderId !== "string" || orderId.trim().length === 0) {
      return { valid: false, error: "orderId is required and must be a non-empty string." };
    }
    if (itemId !== undefined && (typeof itemId !== "string" || itemId.trim().length === 0)) {
      return { valid: false, error: "itemId, if provided, must be a non-empty string." };
    }
    return { valid: true, value: { orderId: orderId.trim(), itemId: itemId ? (itemId as string).trim() : undefined } };
  },
  // The 30-day window / non-returnable-category rule itself now lives once,
  // in order-service - this tool just relays the result. No business logic
  // is duplicated here anymore.
  async handler({ orderId, itemId }) {
    const result = await fetchReturnEligibility(orderId, itemId);
    if (!result.ok) {
      if (result.status === 404) {
        return {
          success: false,
          error: itemId ? `Item "${itemId}" was not found on order "${orderId}".` : `No order found with ID "${orderId}".`,
        };
      }
      return { success: false, error: "Could not check return eligibility right now. Please try again shortly." };
    }
    return { success: true, data: result.data };
  },
};
