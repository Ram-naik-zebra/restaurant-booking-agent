export type RestaurantStatus = "operational" | "closed_temporarily" | "closed_permanently";

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  price: string;
  noise: "quiet" | "loud";
  status: RestaurantStatus;
  hours: { open: string; close: string }; // "HH:MM" 24h, tonight's hours
}

export interface Slot {
  restaurant_id: string;
  party_size: number;
  time: string; // "HH:MM"
  status: "open" | "full";
}

export interface Review {
  restaurant_id: string;
  text: string;
}

export interface BookingLogEntry {
  booking_id: string;
  restaurant_id: string;
  party_size: number;
  time: string;
  created_at: string;
}

// --- Chat / tool-calling shared types ---

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  // present on assistant messages that call tools
  tool_calls?: { id: string; name: string; arguments: Record<string, any> }[];
  // present on tool result messages
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface LlmChatResult {
  toolCalls?: LlmToolCall[];
  content?: string | null;
}

export interface LlmProvider {
  chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LlmChatResult>;
}

// --- Trace (what the UI displays) ---

export interface TraceEntry {
  type: "tool_call";
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

// --- Session state ---

export interface PendingAsk {
  message: string;
  restaurant_id: string;
  proposed_time: string;
}

export interface SessionState {
  sessionId: string;
  messages: ChatMessage[];
  trace: TraceEntry[];
  originalPrompt: string;
  ambianceRequested: boolean;
  approvedRestaurantId: string | null; // set only after ask_user receives "yes" for this restaurant
  pendingAsk: PendingAsk | null;
  forceFailNextBooking: boolean;
  done: boolean;
  finalMessage: string | null;
  createdAt: number;
  updatedAt: number;
}
