/**
 * types.ts (frontend)
 * --------------------
 * Shared TypeScript shapes for the frontend. These mirror the shapes the
 * backend sends over HTTP (see backend/src/types.ts) - keeping them in sync
 * is how TypeScript can catch mistakes like "I forgot the server renamed a
 * field" at compile time instead of at runtime in the browser.
 */

// One row of the on-screen trace: one tool the agent called, what arguments
// it used, and what the tool returned. Rendered by components/TraceView.tsx.
export interface TraceEntry {
  type: "tool_call";
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

// A question the agent is currently waiting on the user to answer (set when
// the backend's ask_user tool was called). Rendered by components/ApprovalPanel.tsx.
export interface PendingAsk {
  message: string;
  restaurant_id: string;
  proposed_time: string;
}

// Which backend engine is driving the conversation.
// "regex" parses the request locally. "llm" asks the configured model.
export type AgentEngine = "llm" | "regex";

// A restaurant formatted for display as a card - see backend/src/types.ts.
// Only present on "browse" answers (e.g. "list top rated restaurants"),
// never on a booking proposal or confirmation.
export interface RestaurantCard {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  price: string;
  priceRange: string;
  rating: number;
  reviewCount: number;
  distanceMiles: number;
  noise: "quiet" | "loud";
  status: "operational" | "closed_temporarily" | "closed_permanently";
  hours: { open: string; close: string };
  openTonight: boolean;
}

// The JSON body returned by both POST /api/agent/start and
// POST /api/agent/respond (see backend/src/server.ts and api.ts below).
export interface AgentResponse {
  sessionId: string;
  engine?: AgentEngine;
  trace: TraceEntry[];
  pendingAsk: PendingAsk | null;
  done: boolean;
  finalMessage: string | null;
  restaurants?: RestaurantCard[] | null;
  error?: string;
}

// The JSON body returned by GET /api/agent/status/:sessionId - just a short
// "what's happening right now" string (or null if there isn't one).
export interface AgentStatusResponse {
  status: string | null;
}
