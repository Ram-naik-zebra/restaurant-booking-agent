/**
 * types.ts
 * --------
 * This file has NO logic - it only defines TypeScript "shapes" (types and
 * interfaces) that are shared across the whole backend. Think of it as the
 * dictionary everyone else in this project agrees to use, so that e.g.
 * server.ts, loop.ts, and tools.ts all talk about a "Restaurant" in exactly
 * the same way.
 *
 * Grouped into three sections:
 * 1. Fake-city domain data shapes (Restaurant, Slot, Review, BookingLogEntry)
 * 2. Chat / LLM tool-calling shapes (ChatMessage, ToolSchema, LlmProvider, ...)
 * 3. Agent session shapes (SessionState, PendingAsk, TraceEntry)
 */

// A restaurant's business status - independent of what time it is tonight.
// "operational" = normal business, can potentially be booked.
// "closed_temporarily" / "closed_permanently" = the business itself is
// closed, so it can NEVER be booked, no matter what time you ask for.
export type RestaurantStatus = "operational" | "closed_temporarily" | "closed_permanently";

// One row of our fake-city restaurant data (see backend/src/data/restaurants.json).
export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  price: string; // "$" / "$$" / "$$$" symbol, e.g. for quick filtering/sorting
  priceRange: string; // the same price band spelled out, e.g. "$25-35 per person"
  rating: number; // 1-5, one decimal place - mocked for this demo, not computed from review text
  reviewCount: number; // how many (also mocked) reviews back that rating
  distanceMiles: number; // mocked distance from "you" - this fake city has no real geocoding
  noise: "quiet" | "loud";
  status: RestaurantStatus;
  hours: { open: string; close: string }; // "HH:MM" 24h, tonight's hours
}

// A restaurant formatted for display as a card in the UI - see
// agent/regexEngine.ts's listRestaurants(), used for "browse" results (e.g.
// "list top rated restaurants") rather than a single booking proposal.
// Carries everything the frontend needs to render one card without
// re-deriving it from the trace.
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
  status: RestaurantStatus;
  hours: { open: string; close: string };
  openTonight: boolean;
}

// One row of our fake-city table-availability data (see backend/src/data/slots.json).
// Each entry says: for this restaurant, at this time, for this many people,
// is there a table ("open") or not ("full")?
export interface Slot {
  restaurant_id: string;
  party_size: number;
  time: string; // "HH:MM"
  status: "open" | "full";
}

// One row of our fake-city reviews data (see backend/src/data/reviews.json).
export interface Review {
  restaurant_id: string;
  text: string;
}

// One row written to backend/src/data/bookingLog.json whenever a booking
// succeeds. This is our fake "reservation system" record.
export interface BookingLogEntry {
  booking_id: string;
  restaurant_id: string;
  party_size: number;
  time: string;
  created_at: string;
}

// --- Chat / tool-calling shared types ---
// These types describe the conversation between our server and the LLM
// (Ollama or Gemini), in a shape that's independent of either provider's
// own API format. llmProvider.ts / ollamaProvider.ts / geminiProvider.ts
// convert to/from this shared shape.

// Who "said" a given message in the conversation.
// "system"   = the instructions we give the model once, up front (see systemPrompt.ts)
// "user"     = the human's message, OR a tool result we're feeding back in (see ChatMessage below)
// "assistant"= something the LLM said/decided
// "tool"     = the result of running a tool, sent back to the LLM
export type ChatRole = "system" | "user" | "assistant" | "tool";

// One message in the conversation history kept in SessionState.messages.
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  // present on assistant messages that call tools
  tool_calls?: {
    id: string;
    name: string;
    arguments: Record<string, any>;
    // Gemini-only: opaque "thinking" token the API attaches to a functionCall
    // part. Must be echoed back verbatim on the next turn's matching
    // functionCall part or the API rejects the request - see geminiProvider.ts.
    thoughtSignature?: string;
  }[];
  // present on tool result messages
  tool_call_id?: string;
  name?: string;
}

// Describes one tool (function) the LLM is allowed to call, in the format
// both Ollama (OpenAI-style) and Gemini providers can translate from.
// See toolSchemas.ts for the actual list of tools used in this app.
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

// One "the model wants to call this tool with these arguments" request,
// as returned by an LlmProvider.chat() call.
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}

// What an LlmProvider.chat() call returns: EITHER one or more tool calls to
// run, OR plain text content (used when the model has nothing left to call
// a tool for - see the "MANDATORY RULE" in systemPrompt.ts for why this is
// actually disallowed for most turns in this app).
export interface LlmChatResult {
  toolCalls?: LlmToolCall[];
  content?: string | null;
}

// The common interface both OllamaProvider and GeminiProvider implement.
// loop.ts only ever talks to "an LlmProvider" - it never needs to know
// which concrete provider it's using.
export interface LlmProvider {
  chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LlmChatResult>;
}

// --- Trace (what the UI displays) ---

// One row of the on-screen "trace" the frontend shows the user, recording
// every tool call the agent made, what arguments it used, and what the
// tool returned. This is what makes the agent's reasoning visible/debuggable.
export interface TraceEntry {
  type: "tool_call";
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

// --- Session state ---

// Captures a single "ask_user" question that is currently waiting for the
// human to answer (yes/no) before the agent loop can continue.
export interface PendingAsk {
  message: string;
  restaurant_id: string;
  proposed_time: string;
}

// Which brain is driving this conversation.
// "llm"   = the tool-calling loop in agent/loop.ts
// "regex" = the local parser in agent/regexEngine.ts (no model call)
export type AgentEngine = "llm" | "regex";

// Why a restaurant was taken off the regex planner's candidate list.
export type RegexSkipReason = "declined" | "booking_failed";

// One restaurant the regex planner has already checked with the real tools.
export interface RegexEvaluation {
  viableTime: string | null; // "HH:MM" when a table is actually bookable, otherwise null
  reason: string;
}

// Working memory for the local regex planner, so a paused ask_user can
// resume without calling a model. Rebuilt fields come from the prompt;
// candidate/evaluation fields accumulate as tools run.
export interface RegexPlan {
  partySize: number;
  cuisine?: string;
  area?: string;
  time: string; // "HH:MM"
  noise?: "quiet" | "loud";
  preferredRestaurantId?: string;
  // "none" = haven't searched yet
  // "filtered" = searched with the area filter (only when the prompt named one)
  // "widened" = searched without the area filter, or there was no area to drop
  searchStage: "none" | "filtered" | "widened";
  candidateIds: string[];
  evaluated: Record<string, RegexEvaluation>;
  skipped: Record<string, RegexSkipReason>;
  proposal: { restaurantId: string; time: string } | null;
}

// All the state we need to remember for one user's conversation with the
// agent, between HTTP requests (the browser calls our API multiple times -
// once to start, then again each time it answers an ask_user question - and
// this object is how we remember everything in between those calls).
// See sessionStore.ts for where these live (an in-memory Map).
export interface SessionState {
  sessionId: string;
  engine: AgentEngine;
  messages: ChatMessage[];
  trace: TraceEntry[];
  originalPrompt: string;
  ambianceRequested: boolean;
  approvedRestaurantId: string | null; // set only after ask_user receives "yes" for this restaurant
  pendingAsk: PendingAsk | null;
  forceFailNextBooking: boolean;
  aborted: boolean; // set by POST /api/agent/abort; the loop stops before the next tool
  regexPlan: RegexPlan | null;
  done: boolean;
  finalMessage: string | null;
  // Human-readable "what's happening right now" string, updated live as the
  // agent loop progresses through turns/tool calls. Polled by the frontend
  // via GET /api/agent/status/:sessionId while a request is in flight.
  currentStatus: string | null;
  createdAt: number;
  updatedAt: number;
}
