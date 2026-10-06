import { ToolSchema } from "../types";

const RESTAURANT_ID_DESC = "The exact restaurant 'id' field value returned by search_places, e.g. 'r1'. The parameter name must be 'restaurant_id' (not 'place_id' or 'id').";

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "search_places",
    description:
      "Search the city for restaurants matching a cuisine and/or neighborhood. Returns a list of candidate restaurants with id, name, cuisine, neighborhood, price, and noise level. Does NOT tell you if they're open or have a table - use check_hours and check_availability for that.",
    parameters: {
      type: "object",
      properties: {
        cuisine: { type: "string", description: "Cuisine to search for, e.g. 'italian', 'sushi'. Omit to search all cuisines." },
        area: { type: "string", description: "Neighborhood/area to search in, e.g. 'downtown'. Omit to search all areas." }
      }
    }
  },
  {
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
