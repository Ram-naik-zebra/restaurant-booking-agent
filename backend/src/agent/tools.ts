import { SessionState } from "../types";
import { restaurants, findRestaurant, findSlot, reviewsFor, createBooking, findBooking } from "../data/store";

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

export function promptMentionsAmbiance(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return AMBIANCE_KEYWORDS.some((kw) => lower.includes(kw));
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isWithinHours(time: string, open: string, close: string): boolean {
  const t = timeToMinutes(time);
  return t >= timeToMinutes(open) && t <= timeToMinutes(close);
}

// --- Tool implementations ---
// Each tool is a plain function over the fake-city JSON data (store.ts).
// check_availability, read_reviews, and book each contain a hard guardrail
// that cannot be bypassed by the LLM, regardless of what it decides to call.

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
      noise: r.noise
    }))
  };
}

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

// GUARDRAIL #1: a closed place (either meaning of "closed") never gets a
// simulated reservation check - this holds even if the LLM skips check_hours.
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

// GUARDRAIL #2: never reveal review content unless the user's original
// request actually mentioned ambiance/noise - holds regardless of LLM intent.
export function read_reviews(args: { restaurant_id: string }, session: SessionState) {
  if (!session.ambianceRequested) {
    return { skipped: "User did not ask about ambiance/noise - reviews withheld." };
  }
  const restaurant = findRestaurant(args.restaurant_id);
  if (!restaurant) return { error: `Unknown restaurant_id: ${args.restaurant_id}` };

  const list = reviewsFor(args.restaurant_id).map((r) => r.text);
  return { restaurant_id: restaurant.id, name: restaurant.name, reviews: list };
}

// GUARDRAIL #3: booking is rejected unless the session recorded a prior
// ask_user "yes" for this exact restaurant - independent of LLM reliability.
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

export function confirm_booking(args: { booking_id: string }) {
  const booking = findBooking(args.booking_id);
  if (!booking) return { confirmed: false, reason: "No booking found with that id." };
  return { confirmed: true, booking };
}
