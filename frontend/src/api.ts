import type { AgentResponse } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Request failed with status ${res.status}`);
  }
  return data as T;
}

export function startAgent(prompt: string, forceFailNextBooking: boolean): Promise<AgentResponse> {
  return postJson<AgentResponse>("/api/agent/start", { prompt, forceFailNextBooking });
}

export function respondToAgent(sessionId: string, answer: string): Promise<AgentResponse> {
  return postJson<AgentResponse>("/api/agent/respond", { sessionId, answer });
}
