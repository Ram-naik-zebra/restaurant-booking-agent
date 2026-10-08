/**
 * loop.ts
 * -------
 * THE MOST IMPORTANT FILE IN THE APP. This is where the actual "agent"
 * behavior lives: repeatedly asking the LLM "given everything that's
 * happened so far, what's the next tool call?", running that tool, feeding
 * the result back, and repeating - until the agent either needs to ask the
 * human something (ask_user) or is done (finish).
 *
 * There is NO hard-coded order of tools anywhere in this file. Compare that
 * to a normal script that might say "step 1: search, step 2: check hours,
 * step 3: book" - here, every single step is a fresh decision made by the
 * LLM based on what the previous tool actually returned. That's what makes
 * this an "agent" rather than a fixed pipeline with an LLM bolted on.
 *
 * Exports two functions used by server.ts:
 *   - runAgentLoop(session)   - runs the loop until it pauses or finishes
 *   - recordUserAnswer(session, answer) - records the human's yes/no reply
 */

import { SessionState, ChatMessage, RestaurantCard, TraceEntry } from "../types";
import { getLlmProvider } from "./llmProvider";
import { TOOL_SCHEMAS } from "./toolSchemas";
import { SYSTEM_PROMPT } from "./systemPrompt";
import * as tools from "./tools";
import { touchSession } from "./sessionStore";
import { resolveRestaurantId } from "../data/store";

const MAX_TURNS = 20; // safety cap against infinite loops (includes nudge-retries below)
const MAX_NUDGES = 3; // see nudge-and-retry note in runAgentLoop

// Friendly "what's happening" text shown to the user while each tool runs.
// Purely cosmetic - has no effect on behavior, just live progress for the UI.
const TOOL_STATUS_MESSAGES: Record<string, string> = {
  search_places: "Searching for restaurants...",
  check_hours: "Checking opening hours...",
  check_availability: "Checking table availability...",
  read_reviews: "Reading recent reviews...",
  ask_user: "Preparing a question for you...",
  book: "Booking your table...",
  confirm_booking: "Confirming the booking...",
  finish: "Wrapping up..."
};

/**
 * Updates the session's "what's happening right now" text (polled by the
 * frontend via GET /api/agent/status/:sessionId) and marks the session as
 * recently active. Purely for the live progress UI - has no effect on the
 * agent's actual decisions.
 * @param session - the session to update
 * @param status - a short human-readable string, or null to clear it
 */
function setStatus(session: SessionState, status: string | null) {
  session.currentStatus = status;
  touchSession(session);
}

// What runAgentLoop() returns to its caller (server.ts), and what gets sent
// back to the frontend as the HTTP response body.
export interface LoopResult {
  trace: TraceEntry[];
  pendingAsk: SessionState["pendingAsk"];
  done: boolean;
  finalMessage: string | null;
  // Only set for "browse" answers (see agent/regexEngine.ts's listRestaurants) -
  // lets the frontend render a card grid instead of parsing finalMessage.
  // Never set by the LLM path or by a booking proposal/confirmation.
  restaurants?: RestaurantCard[] | null;
}

/** Ends the loop when the UI has asked this session to stop. */
export function stoppedResult(session: SessionState): LoopResult | null {
  if (!session.aborted) return null;
  session.done = true;
  session.pendingAsk = null;
  session.finalMessage = "Stopped. I didn't keep going.";
  setStatus(session, null);
  return { trace: session.trace, pendingAsk: null, done: true, finalMessage: session.finalMessage };
}

/**
 * The core agentic loop: ask the LLM "given everything so far, what's the
 * next tool call?", run it, feed the result back, repeat. There is no
 * hard-coded tool order here - the LLM decides each step from the previous
 * tool's result, per systemPrompt.ts guidance. The loop stops when the LLM
 * calls ask_user, calls finish, or the UI aborts the session.
 *
 * Called from server.ts both to start a brand new conversation (after
 * pushing the user's prompt onto session.messages) and to resume one after
 * the user answers a pending ask_user question.
 *
 * @param session - the conversation's current SessionState (read and mutated in place)
 * @returns a LoopResult describing what happened: either `pendingAsk` is set
 *   (loop paused, waiting on the human) or `done` is true with a `finalMessage`
 *   (the agent finished, successfully or not)
 */
export async function runAgentLoop(session: SessionState): Promise<LoopResult> {
  const provider = getLlmProvider();
  let nudges = 0;

  // Each iteration of this loop = one "turn": one call to the LLM, followed
  // by running whatever tool(s) it decided to call.
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stopped = stoppedResult(session);
    if (stopped) return stopped;

    setStatus(session, turn === 0 ? "Reading your request..." : "Deciding what to do next...");
    const result = await provider.chat(fullMessages(session), TOOL_SCHEMAS);

    const stoppedAfterModel = stoppedResult(session);
    if (stoppedAfterModel) return stoppedAfterModel;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      // Some smaller/local models don't reliably honor tool_choice="required"
      // and occasionally reply with plain prose (e.g. narrating a proposal
      // instead of calling ask_user). Rather than silently ending the
      // conversation there - which would mean the user never actually got a
      // real approval prompt - nudge the model to retry as a real tool call,
      // a bounded number of times, before giving up and surfacing the prose.
      session.messages.push({ role: "assistant", content: result.content ?? "" });

      if (nudges < MAX_NUDGES) {
        nudges++;
        session.messages.push({
          role: "user",
          content:
            "That was plain text, which I cannot act on - you must call a tool. " +
            "If that message was a question or proposal for me, call ask_user now with that exact message. " +
            "If you were done, call finish now with that message. Otherwise call whichever tool investigates next."
        });
        touchSession(session);
        continue; // skip straight to the next turn, without consuming a "real" step
      }

      // Nudges exhausted - surface the model's prose as-is rather than loop forever.
      session.done = true;
      session.finalMessage = result.content ?? "";
      setStatus(session, null);
      return { trace: session.trace, pendingAsk: null, done: true, finalMessage: session.finalMessage };
    }

    // Record the assistant's tool call request(s) in conversation history.
    session.messages.push({
      role: "assistant",
      content: result.content ?? null,
      tool_calls: result.toolCalls
    });

    // Process every tool call in this batch (models usually call one at a
    // time, but nothing here assumes that). If ask_user shows up, we still
    // finish writing a matching "tool" result message for every OTHER call
    // in the same batch first, so the conversation history stays well-formed
    // (every tool_call_id must have a reply) - then pause after the loop.
    let pendingAsk: SessionState["pendingAsk"] | null = null;
    let finishMessage: string | null = null;

    for (const call of result.toolCalls) {
      const stoppedBeforeTool = stoppedResult(session);
      if (stoppedBeforeTool) return stoppedBeforeTool;

      setStatus(session, TOOL_STATUS_MESSAGES[call.name] ?? `Running ${call.name}...`);

      if (call.name === "finish") {
        // "finish" is a control-flow signal, not a data tool - it doesn't
        // live in tools.ts. We just remember the message and let the loop
        // below end things once every call in this batch has been handled.
        finishMessage = String(call.arguments.message ?? "");

        session.trace.push({
          type: "tool_call",
          tool: "finish",
          args: call.arguments,
          result: { status: "done" },
          timestamp: new Date().toISOString()
        });

        session.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: "finish",
          content: JSON.stringify({ status: "done" })
        });
        continue;
      }

      if (call.name === "ask_user") {
        // "ask_user" is also a control-flow signal rather than a plain data
        // tool: instead of returning a result immediately, it causes the
        // loop to PAUSE and wait for a real human response (via
        // recordUserAnswer, triggered from POST /api/agent/respond).
        pendingAsk = {
          message: String(call.arguments.message ?? ""),
          restaurant_id: resolveRestaurantId(String(call.arguments.restaurant_id ?? "")) ?? "",
          proposed_time: String(call.arguments.proposed_time ?? "")
        };

        session.trace.push({
          type: "tool_call",
          tool: "ask_user",
          args: call.arguments,
          result: { status: "waiting_for_user" },
          timestamp: new Date().toISOString()
        });

        session.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: "ask_user",
          content: JSON.stringify({ status: "waiting_for_user" })
        });
        continue;
      }

      // Every other tool name is a normal data tool implemented in tools.ts
      // (search_places, check_hours, check_availability, read_reviews,
      // book, confirm_booking) - look it up and actually run it now.
      const toolResult = executeTool(call.name, call.arguments, session);

      session.trace.push({
        type: "tool_call",
        tool: call.name,
        args: call.arguments,
        result: toolResult,
        timestamp: new Date().toISOString()
      });

      session.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(toolResult)
      });
    }

    touchSession(session);

    if (pendingAsk) {
      // Only now, after every call in the batch has a reply, do we actually
      // pause the loop and hand control back to the human. We do NOT call
      // the LLM again until the frontend posts the answer.
      session.pendingAsk = pendingAsk;
      setStatus(session, null);
      return { trace: session.trace, pendingAsk, done: false, finalMessage: null };
    }

    if (finishMessage !== null) {
      session.done = true;
      session.finalMessage = finishMessage;
      setStatus(session, null);
      return { trace: session.trace, pendingAsk: null, done: true, finalMessage: finishMessage };
    }

    // Neither ask_user nor finish was called - loop back around for another
    // turn, now with this turn's tool result(s) in the conversation history.
  }

  // Safety cap hit - stop and surface to the user rather than looping forever.
  session.done = true;
  session.finalMessage =
    "I wasn't able to finish within a reasonable number of steps. Please try rephrasing your request.";
  setStatus(session, null);
  return { trace: session.trace, pendingAsk: null, done: true, finalMessage: session.finalMessage };
}

/**
 * Called when the frontend posts the user's answer to a pending ask_user
 * question. The approval guardrail in tools.ts (book) only trusts THIS
 * code's "yes" detection - not the LLM's own interpretation of the user's
 * words - so approval can't be talked into existing by a confused model.
 *
 * Does nothing if there is no pendingAsk on the session (defensive no-op).
 *
 * @param session - the session that was paused on an ask_user question
 * @param rawAnswer - the user's raw text answer from the UI (e.g. "yes", "no", or anything else)
 */
export function recordUserAnswer(session: SessionState, rawAnswer: string): void {
  if (!session.pendingAsk) return;

  const normalized = rawAnswer.trim().toLowerCase();
  const isYes = normalized === "yes";

  if (isYes) {
    session.approvedRestaurantId = session.pendingAsk.restaurant_id;
  } else {
    // Any non-exact-"yes" answer (including "no" or free text) does NOT
    // approve a booking. approvedRestaurantId is intentionally left as-is
    // (null, or whatever it already was) rather than trusting free text.
  }

  // Feed the answer back into the conversation as a normal "user" message,
  // so the LLM sees it on its next turn and can react accordingly.
  session.messages.push({
    role: "user",
    content: `User's answer to your proposal: "${rawAnswer}"`
  });

  session.pendingAsk = null;
  touchSession(session);
}

/**
 * Builds the full message list to send to the LLM provider: the standing
 * system instructions (systemPrompt.ts) always first, followed by the
 * entire conversation history recorded on the session so far.
 * @param session - the current session
 * @returns the array of messages ready to pass to provider.chat(...)
 */
function fullMessages(session: SessionState): ChatMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages];
}

// Smaller/local LLMs occasionally drift from the exact schema key names
// (e.g. "place_id" instead of "restaurant_id"). This normalizes a handful of
// common aliases before execution so one minor naming slip doesn't derail
// the whole turn - it does not change which tool gets called or when.
const RESTAURANT_ID_ALIASES = ["restaurant_id", "place_id", "id", "restaurantId", "placeId"];
const BOOKING_ID_ALIASES = ["booking_id", "bookingId", "id"];

/**
 * Cleans up a tool call's raw arguments before running the real tool
 * function, to compensate for small models drifting slightly from the exact
 * schema (see toolSchemas.ts). Two things happen here:
 *   1. If the model used a slightly different key name for the restaurant
 *      or booking id (e.g. "place_id" instead of "restaurant_id"), copy that
 *      value over to the correct key name.
 *   2. If restaurant_id looks like it might actually be a restaurant's NAME
 *      rather than its id (e.g. "Trattoria Rosso" instead of "r1"), resolve
 *      it to the real id (see resolveRestaurantId in data/store.ts).
 *
 * @param args - the raw arguments object exactly as the model produced it
 * @returns a new object with the same arguments, plus any corrections applied
 */
function normalizeArgs(args: Record<string, any>): Record<string, any> {
  const normalized = { ...args };
  if (normalized.restaurant_id === undefined) {
    for (const alias of RESTAURANT_ID_ALIASES) {
      if (normalized[alias] !== undefined) {
        normalized.restaurant_id = normalized[alias];
        break;
      }
    }
  }
  if (normalized.booking_id === undefined) {
    for (const alias of BOOKING_ID_ALIASES) {
      if (normalized[alias] !== undefined) {
        normalized.booking_id = normalized[alias];
        break;
      }
    }
  }
  if (typeof normalized.restaurant_id === "string") {
    normalized.restaurant_id = resolveRestaurantId(normalized.restaurant_id);
  }
  return normalized;
}

/**
 * Dispatches a tool call by name to its real implementation in tools.ts
 * (after normalizing its arguments). This is the one place in the codebase
 * that maps a tool's string `name` (as chosen by the LLM) to an actual
 * function call - everything else just passes tool names around as data.
 *
 * Note: "ask_user" and "finish" are NOT handled here - they're intercepted
 * earlier in runAgentLoop() because they affect the loop's control flow
 * rather than just returning a data result.
 *
 * @param name - the tool name the LLM chose, e.g. "search_places"
 * @param rawArgs - the raw arguments object the LLM provided for that tool
 * @param session - the current session (passed through to tools that need it, e.g. book, read_reviews)
 * @returns whatever the matching tool function in tools.ts returns, or
 *   { error: "Unknown tool: ..." } if the name doesn't match any known tool
 */
function executeTool(name: string, rawArgs: Record<string, any>, session: SessionState): any {
  const args = normalizeArgs(rawArgs);
  switch (name) {
    case "search_places":
      return tools.search_places(args as any);
    case "check_hours":
      return tools.check_hours(args as any);
    case "check_availability":
      return tools.check_availability(args as any);
    case "read_reviews":
      return tools.read_reviews(args as any, session);
    case "book":
      return tools.book(args as any, session);
    case "confirm_booking":
      return tools.confirm_booking(args as any);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
