import { SessionState } from "../types";

// In-memory session store. Lives for the lifetime of this Node process (fine
// on a long-running host like Render; would need a different design on
// stateless serverless functions - see plan's Deployment section).
const sessions = new Map<string, SessionState>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min, basic cleanup of abandoned sessions

export function createSession(sessionId: string, originalPrompt: string, ambianceRequested: boolean): SessionState {
  const now = Date.now();
  const state: SessionState = {
    sessionId,
    messages: [],
    trace: [],
    originalPrompt,
    ambianceRequested,
    approvedRestaurantId: null,
    pendingAsk: null,
    forceFailNextBooking: false,
    done: false,
    finalMessage: null,
    createdAt: now,
    updatedAt: now
  };
  sessions.set(sessionId, state);
  return state;
}

export function getSession(sessionId: string): SessionState | undefined {
  sweepExpired();
  return sessions.get(sessionId);
}

export function touchSession(state: SessionState) {
  state.updatedAt = Date.now();
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, state] of sessions) {
    if (now - state.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
