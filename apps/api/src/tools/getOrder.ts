import type { ToolDefinition } from "./types.js";
import { mockOrders } from "./mockData.js";

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
    const order = mockOrders[orderId];
    if (!order) {
      return { success: false, error: `No order found with ID "${orderId}".` };
    }
    return { success: true, data: order };
  },
};
