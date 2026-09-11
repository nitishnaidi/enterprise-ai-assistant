import type { ToolDefinition } from "./types.js";
import { fetchOrder } from "../services/orderServiceClient.js";

interface GetOrderArgs {
  orderId: string;
}

export const getOrderTool: ToolDefinition<GetOrderArgs> = {
  name: "getOrder",
  description:
    "Look up a single order by its order ID and return its status, items, dates and total. Use this for any question about a specific order that isn't answered by the general policy documents.",
  operationType: "read",
  inputSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description: 'The order ID, e.g. "ORD-123". Ask the user for this if it is not already in the conversation.',
      },
    },
    required: ["orderId"],
  },
  validate(args) {
    if (typeof args !== "object" || args === null) {
      return { valid: false, error: "Arguments must be an object." };
    }
    const orderId = (args as Record<string, unknown>).orderId;
    if (typeof orderId !== "string" || orderId.trim().length === 0) {
      return { valid: false, error: "orderId is required and must be a non-empty string." };
    }
    return { valid: true, value: { orderId: orderId.trim() } };
  },
  async handler({ orderId }) {
    const result = await fetchOrder(orderId);
    if (!result.ok) {
      if (result.status === 404) {
        return { success: false, error: `No order found with ID "${orderId}".` };
      }
      return { success: false, error: "Could not retrieve order details right now. Please try again shortly." };
    }
    return { success: true, data: result.data };
  },
};
