/**
 * tools.ts
 * --------
 * This file contains the actual implementation of every "tool" the LLM is
 * allowed to call (search_places, check_hours, check_availability,
 * read_reviews, book, confirm_booking). Each one is a plain TypeScript
 * function that reads/writes our fake-city data (store.ts) and returns a
 * plain JS object - that object gets JSON-stringified and fed back to the
 * LLM as the tool's result (see executeTool in agent/loop.ts).
 *
 * The (ask_user and finish tools are handled directly in agent/loop.ts
 * instead of here, since they affect the control flow of the loop itself
 * rather than just returning data.)
 *
 * IMPORTANT CONCEPT - "guardrails":
 * Three of these functions (check_availability, read_reviews, book) contain
 * a hard-coded safety check that CANNOT be bypassed no matter what the LLM
 * decides to do. These are marked "GUARDRAIL" below. The difference from a
 * normal "instruction" (like the guidance text in systemPrompt.ts) is that
 * an instruction is just advice the model usually follows but technically
 * could ignore, whereas a guardrail is enforced in plain code - the model
 * has no way around it.
 */

import { SessionState } from "../types";
import { restaurants, findRestaurant, findSlot, reviewsFor, createBooking, findBooking } from "../data/store";

// Keywords that, if present anywhere in the user's original prompt, mean
// they care about ambiance/noise - used by promptMentionsAmbiance() below.
const AMBIANCE_KEYWORDS = [
  "quiet",
  "loud",
  "noisy",
  "noise",
  "lively",
  "romantic",
  "ambiance",
  "ambience",
  "talk",
  "conversation",
  "intimate"
];

/**
 * Checks whether the user's original request mentioned anything related to
 * ambiance or noise level (e.g. "somewhere quiet", "can we talk"). This
 * result is stored once per session (SessionState.ambianceRequested) and is
 * what the read_reviews guardrail checks before ever revealing review text.
 *
 * @param prompt - the user's original free-text request
 * @returns true if any ambiance-related keyword was found, false otherwise
 */
export function promptMentionsAmbiance(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return AMBIANCE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Converts a "HH:MM" 24-hour time string into a plain number of minutes
 * since midnight, so two times can be compared with simple >= / <=.
 * Example: "19:30" -> 19*60 + 30 = 1170
 * @param t - time string in "HH:MM" format
 * @returns total minutes since midnight
 */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Checks whether a given time falls within an open/close window (inclusive).
 * @param time - the time to check, "HH:MM"
 * @param open - opening time, "HH:MM"
 * @param close - closing time, "HH:MM"
 * @returns true if `time` is between `open` and `close`, otherwise false
 */
function isWithinHours(time: string, open: string, close: string): boolean {
  const t = timeToMinutes(time);
  return t >= timeToMinutes(open) && t <= timeToMinutes(close);
}

// --- Tool implementations ---
// Each tool is a plain function over the fake-city JSON data (store.ts).
// check_availability, read_reviews, and book each contain a hard guardrail
// that cannot be bypassed by the LLM, regardless of what it decides to call.

/**
 * TOOL: search_places
 * Searches the fake city for restaurants matching an optional cuisine and/or
 * neighborhood filter. This is usually the FIRST tool the agent calls.
 * Deliberately does NOT check hours or table availability - just a basic
 * "what restaurants exist that roughly match" search, like a maps search.
 *
 * @param args.cuisine - optional cuisine filter, e.g. "italian" (case-insensitive, partial match)
 * @param args.area - optional neighborhood filter, e.g. "downtown" (case-insensitive, partial match)
 * @returns { count, restaurants: [{ id, name, cuisine, neighborhood, price, priceRange, rating, reviewCount, distanceMiles, noise }] }
 */
export function search_places(args: { cuisine?: string; area?: string }) {
  const { cuisine, area } = args;
  const results = restaurants.filter((r) => {
    const cuisineMatch = !cuisine || r.cuisine.toLowerCase().includes(String(cuisine).toLowerCase());
    const areaMatch = !area || r.neighborhood.toLowerCase().includes(String(area).toLowerCase());
    return cuisineMatch && areaMatch;
  });
  return {
    count: results.length,
    restaurants: results.map((r) => ({
      id: r.id,
      name: r.name,
      cuisine: r.cuisine,
      neighborhood: r.neighborhood,
      price: r.price,
      priceRange: r.priceRange,
      rating: r.rating,
      reviewCount: r.reviewCount,
      distanceMiles: r.distanceMiles,
      noise: r.noise
    }))
  };
}

/**
 * TOOL: check_hours
 * Checks ONE specific restaurant for two separate things:
 *   1. open_tonight - is the requested time within tonight's opening hours?
 *   2. status - is the business itself operational, or closed (temporarily
 *      or permanently)? A restaurant can be "open_tonight: true" by the
 *      clock but still unbookable if status isn't "operational".
 *
 * @param args.restaurant_id - the restaurant's id, e.g. "r1"
 * @param args.time - "HH:MM" 24h time string the user wants
 * @returns { restaurant_id, name, status, hours, open_tonight } or { error } if unknown id
 */
export function check_hours(args: { restaurant_id: string; time: string }) {
  const restaurant = findRestaurant(args.restaurant_id);
  if (!restaurant) return { error: `Unknown restaurant_id: ${args.restaurant_id}` };

  const open_tonight = isWithinHours(args.time, restaurant.hours.open, restaurant.hours.close);
  return {
    restaurant_id: restaurant.id,
    name: restaurant.name,
    status: restaurant.status, // "operational" | "closed_temporarily" | "closed_permanently"
    hours: restaurant.hours,
    open_tonight
  };
}

/**
 * TOOL: check_availability
 * Checks whether a restaurant has a free table for a given party size and
 * time. This is the ONE place we simulate a real "reservation system" check.
 *
 * GUARDRAIL #1: a closed place (either meaning of "closed" - see check_hours
 * above) never gets a simulated reservation check at all - this holds true
 * EVEN IF the LLM skipped calling check_hours first and jumped straight
 * here. The code itself refuses to pretend a closed restaurant has tables.
 *
 * @param args.restaurant_id - the restaurant's id
 * @param args.party_size - number of people in the party
 * @param args.time - "HH:MM" 24h time string
 * @returns either { blocked: "closed", reason } (guardrail triggered), or
 *   { restaurant_id, name, party_size, time, status: "open" | "full" }, or
 *   { error } if the restaurant id is unknown
 */
export function check_availability(args: { restaurant_id: string; party_size: number; time: string }) {
  const restaurant = findRestaurant(args.restaurant_id);
  if (!restaurant) return { error: `Unknown restaurant_id: ${args.restaurant_id}` };

  if (restaurant.status !== "operational") {
    return {
      blocked: "closed",
      reason: `${restaurant.name} is ${restaurant.status.replace("_", " ")} - no reservation check performed.`
    };
  }
  if (!isWithinHours(args.time, restaurant.hours.open, restaurant.hours.close)) {
    return {
      blocked: "closed",
      reason: `${restaurant.name} is closed for the night at ${args.time} (hours: ${restaurant.hours.open}-${restaurant.hours.close}) - no reservation check performed.`
    };
  }

  const slot = findSlot(args.restaurant_id, args.party_size, args.time);
  const status = slot ? slot.status : "full"; // no recorded slot = treat as no table
  return {
    restaurant_id: restaurant.id,
    name: restaurant.name,
    party_size: args.party_size,
    time: args.time,
    status
  };
}

/**
 * TOOL: read_reviews
 * Returns short fake customer reviews for a restaurant, mainly useful for
 * judging ambiance/noise (e.g. do reviewers call it "quiet" or "loud"?).
 *
 * GUARDRAIL #2: review text is never revealed unless the user's ORIGINAL
 * request actually mentioned ambiance/noise (see promptMentionsAmbiance
 * above, checked once at session start). This holds true even if the LLM
 * decides to call this tool anyway - the code itself withholds the data.
 *
 * @param args.restaurant_id - the restaurant's id
 * @param session - the current SessionState (used to check session.ambianceRequested)
 * @returns either { skipped: "..." } (guardrail triggered), or
 *   { restaurant_id, name, reviews: string[] }, or { error } if unknown id
 */
export function read_reviews(args: { restaurant_id: string }, session: SessionState) {
  if (!session.ambianceRequested) {
    return { skipped: "User did not ask about ambiance/noise - reviews withheld." };
  }
  const restaurant = findRestaurant(args.restaurant_id);
  if (!restaurant) return { error: `Unknown restaurant_id: ${args.restaurant_id}` };

  const list = reviewsFor(args.restaurant_id).map((r) => r.text);
  return { restaurant_id: restaurant.id, name: restaurant.name, reviews: list };
}

/**
 * TOOL: book
 * Attempts to book a table. This is the single most important guardrail in
 * the whole app, because it's the one tool with a real-world consequence.
 *
 * GUARDRAIL #3: booking is REJECTED unless the session recorded a prior
 * ask_user answer of exactly "yes" for this EXACT restaurant_id (see
 * recordUserAnswer in agent/loop.ts, which sets session.approvedRestaurantId).
 * This holds true no matter how confident or insistent the LLM's reasoning
 * is - approval is tracked in server-side code, not trusted from the model.
 *
 * The approval is also "consumed" immediately (set back to null) the moment
 * this function runs, even before checking whether the booking actually
 * succeeds - so if this attempt fails and the LLM tries the SAME restaurant
 * again, it must get a fresh "yes" from the user first.
 *
 * `forceFailNextBooking` is a one-shot testing flag (see server.ts's
 * POST /api/agent/start) that simulates a booking system failure, to verify
 * the agent correctly proposes a different restaurant afterwards instead of
 * giving up.
 *
 * @param args.restaurant_id - the restaurant's id
 * @param args.party_size - number of people
 * @param args.time - "HH:MM" 24h time string
 * @param session - the current SessionState (checked/mutated for approval + forceFailNextBooking)
 * @returns on success: { success: true, booking_id, restaurant_id, restaurant_name, party_size, time }
 *   on failure: { success: false, error }
 */
export function book(args: { restaurant_id: string; party_size: number; time: string }, session: SessionState) {
  if (session.approvedRestaurantId !== args.restaurant_id) {
    return {
      success: false,
      error: "Not approved: the user has not said yes via ask_user for this exact restaurant yet."
    };
  }

  // Consume the approval immediately - each booking attempt requires its own
  // fresh "yes", even if this attempt fails and the LLM retries the same
  // restaurant_id afterwards.
  session.approvedRestaurantId = null;

  if (session.forceFailNextBooking) {
    session.forceFailNextBooking = false; // consume the forced failure (one-shot)
    return {
      success: false,
      error: "Booking system timed out while confirming the table. Try another restaurant."
    };
  }

  const restaurant = findRestaurant(args.restaurant_id);
  if (!restaurant) return { success: false, error: `Unknown restaurant_id: ${args.restaurant_id}` };

  const entry = createBooking(args.restaurant_id, args.party_size, args.time);
  return {
    success: true,
    booking_id: entry.booking_id,
    restaurant_id: entry.restaurant_id,
    restaurant_name: restaurant.name,
    party_size: entry.party_size,
    time: entry.time
  };
}

/**
 * TOOL: confirm_booking
 * Double-checks that a booking created by `book` really exists in our fake
 * booking log, before the agent tells the user "you're all set". Mostly a
 * sanity check / extra step to mirror what a real booking flow would do.
 *
 * @param args.booking_id - the booking_id returned by a successful `book` call
 * @returns { confirmed: true, booking } if found, or { confirmed: false, reason } if not
 */
export function confirm_booking(args: { booking_id: string }) {
  const booking = findBooking(args.booking_id);
  if (!booking) return { confirmed: false, reason: "No booking found with that id." };
  return { confirmed: true, booking };
}
