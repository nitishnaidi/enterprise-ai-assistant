// Thin authenticated client for the real order-service (a separate
// repo/process - see ../../../../order-service). This is the only file that
// knows order-service's URLs and auth mechanics; tool handlers just call
// these functions and get back plain data or a typed failure.
//
// The assistant authenticates as a seeded "agent" account, the same way any
// human agent would - logging in and getting a JWT - rather than through a
// special bypass. It is bound by whatever the "agent" role is allowed to do
// in order-service, nothing more.

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || "http://localhost:4100";
const AGENT_EMAIL = process.env.ORDER_SERVICE_AGENT_EMAIL;
const AGENT_PASSWORD = process.env.ORDER_SERVICE_AGENT_PASSWORD;

// order-service issues 1h tokens by default; refresh a few minutes early
// rather than racing an exact expiry.
const TOKEN_LIFETIME_MS = 55 * 60 * 1000;

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

export interface OrderServiceItem {
  itemId: string;
  name: string;
  category: string;
  quantity: number;
  price: number;
}

export interface OrderServiceOrder {
  orderId: string;
  customerId: string;
  orderDate: string;
  deliveryDate: string | null;
  status: string;
  total: number;
  items: OrderServiceItem[];
}

export interface OrderServiceEligibility {
  orderId: string;
  eligible?: boolean;
  reason?: string;
  daysSinceDelivery?: number;
  returnWindowDays?: number;
  items?: { itemId: string; name: string; eligible: boolean; reason: string }[];
}

export interface OrderServiceTicket {
  ticketId: string;
  orderId: string | null;
  customerId: string;
  reason: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type OrderServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function login(): Promise<string> {
  if (!AGENT_EMAIL || !AGENT_PASSWORD) {
    throw new Error("ORDER_SERVICE_AGENT_EMAIL/ORDER_SERVICE_AGENT_PASSWORD are not configured.");
  }
  const res = await fetch(`${ORDER_SERVICE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AGENT_EMAIL, password: AGENT_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`order-service login failed (${res.status})`);
  }
  const data = (await res.json()) as { token: string };
  cachedToken = data.token;
  cachedTokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
  return cachedToken;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  return login();
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<OrderServiceResult<T>> {
  const token = await getToken();
  const res = await fetch(`${ORDER_SERVICE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && retryOn401) {
    cachedToken = null;
    return request<T>(path, init, false);
  }

  if (!res.ok) {
    const body = (await safeJson(res)) as { error?: string } | null;
    return { ok: false, status: res.status, error: body?.error || `order-service returned ${res.status}` };
  }

  return { ok: true, data: (await res.json()) as T };
}

export function fetchOrder(orderId: string): Promise<OrderServiceResult<OrderServiceOrder>> {
  return request(`/orders/${encodeURIComponent(orderId)}`);
}

export function fetchReturnEligibility(orderId: string, itemId?: string): Promise<OrderServiceResult<OrderServiceEligibility>> {
  const qs = itemId ? `?itemId=${encodeURIComponent(itemId)}` : "";
  return request(`/orders/${encodeURIComponent(orderId)}/return-eligibility${qs}`);
}

export function createTicket(input: {
  orderId?: string;
  customerId: string;
  reason: string;
  description: string;
}): Promise<OrderServiceResult<OrderServiceTicket>> {
  return request(`/tickets`, { method: "POST", body: JSON.stringify(input) });
}
