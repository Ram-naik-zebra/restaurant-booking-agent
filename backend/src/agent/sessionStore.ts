/**
 * sessionStore.ts
 * ---------------
 * Keeps track of every ongoing conversation ("session") in a simple
 * in-memory Map (sessionId -> SessionState). A session is how we remember
 * everything about one conversation (message history, trace, pending
 * question, etc. - see SessionState in types.ts) BETWEEN separate HTTP
 * requests, since the browser calls our API once to start the conversation
 * and again each time the user answers an ask_user question.
 *
 * Important limitation: because this is just a JS Map living in server
 * memory, all sessions are LOST if the server process restarts. This is
 * fine for a long-running host like Render, but would NOT work unchanged on
 * stateless serverless functions (e.g. plain Vercel functions), where a new
 * process can spin up per-request.
 */

import { AgentEngine, SessionState } from "../types";

// In-memory session store. Lives for the lifetime of this Node process (fine
// on a long-running host like Render; would need a different design on
// stateless serverless functions - see plan's Deployment section).
const sessions = new Map<string, SessionState>();
// Session ids the UI aborted before POST /start had created them yet.
const abortedBeforeCreate = new Set<string>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min, basic cleanup of abandoned sessions

/**
 * Creates a brand new SessionState, stores it in the map, and returns it.
 * Called once per conversation, from POST /api/agent/start in server.ts.
 *
 * @param sessionId - unique id for this conversation (generated with uuid)
 * @param originalPrompt - the user's original free-text request, kept around
 *   so later tool calls (like read_reviews) can check what the user actually asked for
 * @param ambianceRequested - precomputed true/false: did the original prompt
 *   mention ambiance/noise? (see promptMentionsAmbiance in tools.ts) - this
 *   is what the read_reviews guardrail checks
 * @param engine - "llm" or "regex", chosen in the UI for this conversation
 * @returns the newly created SessionState, ready to have messages pushed onto it
 */
export function createSession(
  sessionId: string,
  originalPrompt: string,
  ambianceRequested: boolean,
  engine: AgentEngine
): SessionState {
  const now = Date.now();
  const state: SessionState = {
    sessionId,
    engine,
    messages: [],
    trace: [],
    originalPrompt,
    ambianceRequested,
    approvedRestaurantId: null,
    pendingAsk: null,
    forceFailNextBooking: false,
    aborted: abortedBeforeCreate.has(sessionId),
    regexPlan: null,
    done: false,
    finalMessage: null,
    currentStatus: null,
    createdAt: now,
    updatedAt: now
  };
  abortedBeforeCreate.delete(sessionId);
  sessions.set(sessionId, state);
  return state;
}

/**
 * Marks a conversation to stop. If the session does not exist yet, the flag
 * is remembered so createSession still comes up already aborted.
 */
export function abortSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    abortedBeforeCreate.add(sessionId);
    return;
  }
  session.aborted = true;
  session.currentStatus = "Stopping...";
  touchSession(session);
}

/**
 * Looks up an existing session by its id.
 * @param sessionId - the id returned by createSession / POST /api/agent/start
 * @returns the SessionState if it exists and hasn't expired, otherwise undefined
 *   (undefined means "not found" - callers should respond with a 404, see server.ts)
 */
export function getSession(sessionId: string): SessionState | undefined {
  sweepExpired(); // opportunistically clean up old sessions on every lookup
  return sessions.get(sessionId);
}

/**
 * Updates a session's "last used" timestamp to now. Called after every
 * change to a session (new message, new trace entry, etc.) so sweepExpired()
 * knows this session is still active and shouldn't be deleted yet.
 * @param state - the session to mark as recently used
 */
export function touchSession(state: SessionState) {
  state.updatedAt = Date.now();
}

/**
 * Deletes any session that hasn't been touched in over SESSION_TTL_MS
 * (30 minutes). This is simple "garbage collection" so abandoned
 * conversations don't accumulate in memory forever.
 * Not exported - called automatically from getSession().
 */
function sweepExpired() {
  const now = Date.now();
  for (const [id, state] of sessions) {
    if (now - state.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
