/**
 * toolSchemas.ts
 * --------------
 * This file has almost no logic - it's a plain data array describing every
 * tool the LLM is allowed to call, in the format "function calling" APIs
 * expect: a name, a plain-English description, and a JSON Schema describing
 * its parameters.
 *
 * WHY THIS MATTERS: the LLM never sees our actual TypeScript functions
 * (tools.ts). Instead, we send it this list of schemas alongside the
 * conversation, and the model's job is to pick a `name` from this list and
 * produce `arguments` matching the schema. Our code (agent/loop.ts) then
 * takes that choice and actually calls the matching real function. The
 * `description` text here is effectively part of the model's instructions -
 * a vague description leads to a confused model, so these are written to be
 * as explicit as possible (see RESTAURANT_ID_DESC below, which exists purely
 * to stop smaller models from inventing a different parameter name).
 *
 * TOOL_SCHEMAS is consumed by both OllamaProvider and GeminiProvider
 * (providers/*.ts), which each translate it into their own provider's
 * native function-calling format.
 */

import { ToolSchema } from "../types";

// Repeated verbatim in every tool that takes a restaurant_id, to reduce the
// chance a smaller LLM invents a different parameter name (e.g. "place_id")
// or passes a restaurant's NAME instead of its id.
const RESTAURANT_ID_DESC = "The exact restaurant 'id' field value returned by search_places, e.g. 'r1'. The parameter name must be 'restaurant_id' (not 'place_id' or 'id').";

// The full list of tools exposed to the LLM. See tools.ts for the matching
// implementations, and agent/loop.ts's executeTool() for how a tool name
// here gets dispatched to the real function.
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    // Usually the FIRST tool called: a broad search with no guarantees about
    // whether results are open or bookable.
    name: "search_places",
    description:
      "Search the city for restaurants matching a cuisine and/or neighborhood. Returns a list of candidate restaurants with id, name, cuisine, neighborhood, price (symbol), priceRange (e.g. '$25-35 per person'), rating (1-5), reviewCount, distanceMiles, and noise level. Does NOT tell you if they're open or have a table - use check_hours and check_availability for that.",
    parameters: {
      type: "object",
      properties: {
        cuisine: { type: "string", description: "Cuisine to search for, e.g. 'italian', 'sushi'. Omit to search all cuisines." },
        area: { type: "string", description: "Neighborhood/area to search in, e.g. 'downtown'. Omit to search all areas." }
      }
    }
  },
  {
    // Checks BOTH tonight's hours AND whether the business is open at all.
    name: "check_hours",
    description:
      "Check whether a specific restaurant is open tonight at a given time, AND whether it is operating as a business at all. Returns both: (1) open_tonight - whether the requested time falls within tonight's hours, and (2) status - 'operational', 'closed_temporarily', or 'closed_permanently'. If status is not 'operational', the restaurant cannot be booked no matter the time.",
    parameters: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: RESTAURANT_ID_DESC },
        time: { type: "string", description: "24h time string 'HH:MM', e.g. '19:00'." }
      },
      required: ["restaurant_id", "time"]
    }
  },
  {
    // Simulated "does a table exist" check - enforces the closed-restaurant guardrail.
    name: "check_availability",
    description:
      "Check whether a restaurant has a table for a given party size at a given time tonight. Returns 'open' or 'full', or a 'blocked' result if the restaurant is closed (temporarily/permanently) or outside tonight's hours - in which case no reservation check was actually performed.",
    parameters: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: RESTAURANT_ID_DESC },
        party_size: { type: "number" },
        time: { type: "string", description: "24h time string 'HH:MM'." }
      },
      required: ["restaurant_id", "party_size", "time"]
    }
  },
  {
    // Gated by the ambiance guardrail - only useful/allowed if the user cared about noise.
    name: "read_reviews",
    description:
      "Read short recent reviews for a restaurant, useful for judging ambiance/noise level (e.g. whether reviewers describe it as 'quiet' or 'loud'). Only call this if the user actually asked about ambiance, noise, or being able to talk - otherwise it will be refused.",
    parameters: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: RESTAURANT_ID_DESC }
      },
      required: ["restaurant_id"]
    }
  },
  {
    // The human-in-the-loop checkpoint: pauses the whole agent loop until
    // the user answers. Handled specially in agent/loop.ts, not in tools.ts.
    name: "ask_user",
    description:
      "Propose ONE specific restaurant + time to the user and wait for their yes/no response. This PAUSES the conversation until the user replies - you will not get another turn until they answer. Always explain briefly why you picked this restaurant. Never call book before the user has said yes via this tool for the exact same restaurant. You MUST call this tool to ask anything - a plain text reply is never seen as a question.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The question/proposal to show the user, including your reasoning." },
        restaurant_id: { type: "string", description: RESTAURANT_ID_DESC },
        proposed_time: { type: "string", description: "24h time string 'HH:MM' being proposed." }
      },
      required: ["message", "restaurant_id", "proposed_time"]
    }
  },
  {
    // The one tool with a real consequence - enforces the approval guardrail.
    name: "book",
    description:
      "Book a table. Will be REJECTED unless the user has already answered yes via ask_user for this exact restaurant. May fail even after approval (simulated booking failure) - check the result's 'success' field; if false, propose the next best candidate to the user via ask_user again.",
    parameters: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: RESTAURANT_ID_DESC },
        party_size: { type: "number" },
        time: { type: "string", description: "24h time string 'HH:MM'." }
      },
      required: ["restaurant_id", "party_size", "time"]
    }
  },
  {
    name: "confirm_booking",
    description: "Verify that a booking actually exists in the booking log, given a booking_id returned by book.",
    parameters: {
      type: "object",
      properties: {
        booking_id: { type: "string", description: "The exact 'booking_id' value returned by book. The parameter name must be 'booking_id'." }
      },
      required: ["booking_id"]
    }
  },
  {
    // The other control-flow tool, alongside ask_user: this is the ONLY
    // valid way the agent can end the conversation (see the MANDATORY RULE
    // in systemPrompt.ts - plain text replies are not allowed).
    name: "finish",
    description:
      "End the conversation with a final message to the user. Call this ONLY when you are truly done: either the booking is confirmed (after book + confirm_booking succeeded), or you have determined nothing can be booked and need to explain why. Do NOT call this if you still need to ask the user something or still have more checking to do - use ask_user for questions, or call another tool to keep investigating.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The final message to show the user." }
      },
      required: ["message"]
    }
  }
];
