// Simulated business data. No database, no external API - the point of this
// stage is the tool-calling mechanics, not a real order system. Dates are
// computed relative to "now" at server start so eligibility rules stay
// meaningful no matter when you run this.

export interface OrderItem {
  itemId: string;
  name: string;
  category: "electronics" | "apparel" | "gift_card";
  quantity: number;
  price: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  orderDate: string;
  deliveryDate: string;
  status: "processing" | "shipped" | "delivered";
  items: OrderItem[];
  total: number;
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export const mockOrders: Record<string, Order> = {
  "ORD-123": {
    orderId: "ORD-123",
    customerId: "CUST-1",
    orderDate: daysAgoIso(10),
    deliveryDate: daysAgoIso(5),
    status: "delivered",
    items: [{ itemId: "ITEM-1", name: "Wireless Mouse", category: "electronics", quantity: 1, price: 25.99 }],
    total: 25.99,
  },
  "ORD-456": {
    orderId: "ORD-456",
    customerId: "CUST-2",
    orderDate: daysAgoIso(50),
    deliveryDate: daysAgoIso(45),
    status: "delivered",
    items: [{ itemId: "ITEM-2", name: "Denim Jacket", category: "apparel", quantity: 1, price: 89.0 }],
    total: 89.0,
  },
  "ORD-789": {
    orderId: "ORD-789",
    customerId: "CUST-1",
    orderDate: daysAgoIso(3),
    deliveryDate: daysAgoIso(3),
    status: "delivered",
    items: [{ itemId: "ITEM-3", name: "$50 Gift Card", category: "gift_card", quantity: 1, price: 50.0 }],
    total: 50.0,
  },
  "ORD-999": {
    orderId: "ORD-999",
    customerId: "CUST-3",
    orderDate: daysAgoIso(1),
    deliveryDate: daysAgoIso(0),
    status: "shipped",
    items: [{ itemId: "ITEM-4", name: "Bluetooth Speaker", category: "electronics", quantity: 1, price: 40.0 }],
    total: 40.0,
  },
};

export interface SupportTicket {
  ticketId: string;
  orderId?: string;
  reason: string;
  description: string;
  status: "open";
  createdAt: string;
}

// In-memory only - resets on server restart. Stands in for a real ticketing
// system/API that createSupportTicket would call in production.
export const mockTickets: SupportTicket[] = [];
let ticketCounter = 1000;

export function createMockTicket(input: { orderId?: string; reason: string; description: string }): SupportTicket {
  const ticket: SupportTicket = {
    ticketId: `TCK-${ticketCounter++}`,
    orderId: input.orderId,
    reason: input.reason,
    description: input.description,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  mockTickets.push(ticket);
  return ticket;
}
