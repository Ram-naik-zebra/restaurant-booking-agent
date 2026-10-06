import { SessionState, ChatMessage, TraceEntry } from "../types";
import { getLlmProvider } from "./llmProvider";
import { TOOL_SCHEMAS } from "./toolSchemas";
import { SYSTEM_PROMPT } from "./systemPrompt";
import * as tools from "./tools";
import { touchSession } from "./sessionStore";
import { resolveRestaurantId } from "../data/store";

const MAX_TURNS = 20; // safety cap against infinite loops (includes nudge-retries below)
const MAX_NUDGES = 3; // see nudge-and-retry note in runAgentLoop

export interface LoopResult {
  trace: TraceEntry[];
  pendingAsk: SessionState["pendingAsk"];
  done: boolean;
  finalMessage: string | null;
}

/**
 * The core agentic loop: ask the LLM "given everything so far, what's the
 * next tool call?", run it, feed the result back, repeat. There is no
 * hard-coded tool order here - the LLM decides each step from the previous
 * tool's result, per systemPrompt.ts guidance. The loop only has two hard
 * stopping conditions: the LLM calls ask_user (pause for human approval) or
 * the LLM responds with no tool call (it's done / explaining something).
 */
export async function runAgentLoop(session: SessionState): Promise<LoopResult> {
  const provider = getLlmProvider();
  let nudges = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await provider.chat(fullMessages(session), TOOL_SCHEMAS);

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
        continue;
      }

      // Nudges exhausted - surface the model's prose as-is rather than loop forever.
      session.done = true;
      session.finalMessage = result.content ?? "";
      touchSession(session);
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
      if (call.name === "finish") {
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
      return { trace: session.trace, pendingAsk, done: false, finalMessage: null };
    }

    if (finishMessage !== null) {
      session.done = true;
      session.finalMessage = finishMessage;
      return { trace: session.trace, pendingAsk: null, done: true, finalMessage: finishMessage };
    }
  }

  // Safety cap hit - stop and surface to the user rather than looping forever.
  session.done = true;
  session.finalMessage =
    "I wasn't able to finish within a reasonable number of steps. Please try rephrasing your request.";
  return { trace: session.trace, pendingAsk: null, done: true, finalMessage: session.finalMessage };
}

/**
 * Called when the frontend posts the user's answer to a pending ask_user
 * question. The approval guardrail in tools.ts (book) only trusts THIS
 * code's "yes" detection - not the LLM's own interpretation of the user's
 * words - so approval can't be talked into existing by a confused model.
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

  session.messages.push({
    role: "user",
    content: `User's answer to your proposal: "${rawAnswer}"`
  });

  session.pendingAsk = null;
  touchSession(session);
}

function fullMessages(session: SessionState): ChatMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages];
}

// Smaller/local LLMs occasionally drift from the exact schema key names
// (e.g. "place_id" instead of "restaurant_id"). This normalizes a handful of
// common aliases before execution so one minor naming slip doesn't derail
// the whole turn - it does not change which tool gets called or when.
const RESTAURANT_ID_ALIASES = ["restaurant_id", "place_id", "id", "restaurantId", "placeId"];
const BOOKING_ID_ALIASES = ["booking_id", "bookingId", "id"];

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
