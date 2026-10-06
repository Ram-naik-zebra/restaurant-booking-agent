export interface TraceEntry {
  type: "tool_call";
  tool: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

export interface PendingAsk {
  message: string;
  restaurant_id: string;
  proposed_time: string;
}

export interface AgentResponse {
  sessionId: string;
  trace: TraceEntry[];
  pendingAsk: PendingAsk | null;
  done: boolean;
  finalMessage: string | null;
  error?: string;
}
