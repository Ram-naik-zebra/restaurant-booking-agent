/**
 * api.ts
 * ------
 * The ONLY file in the frontend that talks to the backend over HTTP (using
 * the browser's built-in `fetch`). Every component calls one of the three
 * functions exported here instead of calling `fetch` directly - that way,
 * if the backend's API ever changes shape, there's exactly one place to update.
 *
 * VITE_API_BASE_URL (set in frontend/.env, see .env.example) controls which
 * backend URL we talk to - localhost for dev, your deployed Render URL in production.
 */

import type { AgentEngine, AgentResponse, AgentStatusResponse } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

/**
 * Small shared helper: POSTs a JS object as JSON to a backend path, parses
 * the JSON response, and throws a readable Error if the server responded
 * with a non-2xx status. Used by startAgent and respondToAgent below so
 * they don't each have to repeat this fetch/parse/error-check boilerplate.
 *
 * @param path - the backend route to call, e.g. "/api/agent/start"
 * @param body - any JSON-serializable object to send as the request body
 * @returns the parsed JSON response, cast to the caller's expected type T
 * @throws Error if the response status is not ok (e.g. 400/404/500)
 */
async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Request failed with status ${res.status}`);
  }
  return data as T;
}

/**
 * Starts a brand new conversation with the agent.
 * @param sessionId - a fresh id generated on the frontend (crypto.randomUUID())
 *   so we can start polling getAgentStatus(sessionId) immediately, even
 *   before this request finishes
 * @param prompt - the user's free-text request, e.g. "table for 4, Italian, tonight at 7"
 * @param forceFailNextBooking - dev/testing toggle: if true, the agent's
 *   next booking attempt will be simulated to fail (see PromptBox.tsx's checkbox)
 * @param engine - "regex" for local pattern matching, "llm" for the model
 * @returns the agent's response: either a pending question or a final result
 */
export function startAgent(
  sessionId: string,
  prompt: string,
  forceFailNextBooking: boolean,
  engine: AgentEngine,
  signal?: AbortSignal
): Promise<AgentResponse> {
  return postJson<AgentResponse>("/api/agent/start", { sessionId, prompt, forceFailNextBooking, engine }, signal);
}

/**
 * Sends the user's answer to a pending ask_user question, resuming the agent loop.
 * @param sessionId - the session returned by startAgent
 * @param answer - the user's answer text - must be exactly "yes" (case-insensitive)
 *   to approve a booking; anything else is treated as "no"/a rejection
 * @returns the agent's response, same shape as startAgent (may pause again, or finish)
 */
export function respondToAgent(sessionId: string, answer: string, signal?: AbortSignal): Promise<AgentResponse> {
  return postJson<AgentResponse>("/api/agent/respond", { sessionId, answer }, signal);
}

/** Asks the backend to stop the running loop for this session before the next tool. */
export function abortAgent(sessionId: string): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/api/agent/abort", { sessionId });
}

// Polled while a /start or /respond call is in flight to show live progress
// ("Searching for restaurants...", "Booking your table...", etc.) instead of
// a static "Working..." label. Failures here are non-fatal - the caller just
// keeps whatever status text it last had.
/**
 * Asks the backend "what is the agent doing right now, for this session?".
 * Called repeatedly on a timer by App.tsx while a request is in flight (see
 * startStatusPolling), NOT awaited as part of the main request/response flow.
 * @param sessionId - the session to check
 * @returns the current status text, or null if there isn't one right now
 */
export async function getAgentStatus(sessionId: string): Promise<AgentStatusResponse> {
  const res = await fetch(`${API_BASE_URL}/api/agent/status/${sessionId}`);
  if (!res.ok) throw new Error(`Status request failed with status ${res.status}`);
  return (await res.json()) as AgentStatusResponse;
}
