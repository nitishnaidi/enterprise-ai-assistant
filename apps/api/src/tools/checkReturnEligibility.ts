import type { ToolDefinition } from "./types.js";
import { mockOrders } from "./mockData.js";

// Mirrors sample-docs/returns-policy.txt sections 1 and 2. Hardcoded here
// (rather than re-running RAG from inside a tool) so this tool is a small,
// deterministic, independently testable business rule - the same shape a
// real "returns eligibility" microservice would have.
const RETURN_WINDOW_DAYS = 30;
const NON_RETURNABLE_CATEGORIES = new Set(["gift_card"]);

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
  async handler({ orderId, itemId }) {
    const order = mockOrders[orderId];
    if (!order) {
      return { success: false, error: `No order found with ID "${orderId}".` };
    }
    if (order.status !== "delivered") {
      return {
        success: true,
        data: { eligible: false, reason: `Order status is "${order.status}"; the return window only starts once an order is delivered.` },
      };
    }

    const items = itemId ? order.items.filter((item) => item.itemId === itemId) : order.items;
    if (itemId && items.length === 0) {
      return { success: false, error: `Item "${itemId}" was not found on order "${orderId}".` };
    }

    const daysSinceDelivery = Math.floor(
      (Date.now() - new Date(order.deliveryDate).getTime()) / (1000 * 60 * 60 * 24)
    );
    const withinWindow = daysSinceDelivery <= RETURN_WINDOW_DAYS;

    const results = items.map((item) => {
      const nonReturnableCategory = NON_RETURNABLE_CATEGORIES.has(item.category);
      const eligible = withinWindow && !nonReturnableCategory;
      let reason: string;
      if (nonReturnableCategory) {
        reason = `${item.name} is in a non-returnable category (${item.category}).`;
      } else if (!withinWindow) {
        reason = `Delivered ${daysSinceDelivery} days ago, which is outside the ${RETURN_WINDOW_DAYS}-day return window.`;
      } else {
        reason = `Delivered ${daysSinceDelivery} days ago, within the ${RETURN_WINDOW_DAYS}-day return window.`;
      }
      return { itemId: item.itemId, name: item.name, eligible, reason };
    });

    return {
      success: true,
      data: { orderId, daysSinceDelivery, returnWindowDays: RETURN_WINDOW_DAYS, items: results },
    };
  },
};
