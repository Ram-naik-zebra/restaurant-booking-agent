/**
 * regexEngine.ts
 * --------------
 * A local stand-in for the LLM loop in loop.ts. The UI can pick this when
 * no model is available. It does not call Ollama or Gemini.
 *
 * What it does instead:
 *   1. Read the free-text request with regular expressions (party size,
 *      cuisine, neighborhood, time, quiet/loud, or a restaurant name).
 *   2. Call the same tools as the LLM path (search_places, check_hours,
 *      check_availability, read_reviews, book, confirm_booking), so the
 *      guardrails in tools.ts still apply.
 *   3. Pause on ask_user until the user says yes, then book.
 *
 * The plan is stored on the session (regexPlan) so a later /respond can
 * continue from the same proposal without parsing the whole conversation
 * again.
 *
 * BROWSE REQUESTS: some common phrases aren't booking requests at all - e.g.
 * "Can you list top rated restaurants", "What are the best sushi spots",
 * "Show me quiet Italian places downtown". isListIntent() recognizes these
 * (a "list/show/recommend/best/top rated" phrase, no booking-ish wording
 * like "book" or "table for 4") and listRestaurants() answers them directly
 * with a filtered list via finish() - no ask_user, no booking plan.
 */

import { Restaurant, RegexEvaluation, RegexPlan, RestaurantCard, SessionState } from "../types";
import { findRestaurant, restaurants } from "../data/store";
import { touchSession } from "./sessionStore";
import * as tools from "./tools";
import { stoppedResult, type LoopResult } from "./loop";

const DEFAULT_PARTY_SIZE = 2;
const DEFAULT_TIME = "19:00";

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

// Cuisine words we understand, plus a few everyday aliases for the cuisines
// actually present in restaurants.json.
const CUISINE_ALIASES: Record<string, string> = {
  pasta: "italian",
  pizza: "italian",
  tacos: "mexican",
  taco: "mexican"
};

const PARTY_PATTERN = /\b(?:table\s+for|party\s+of|for)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:people|guests|persons)\b/i;
const TIME_MERIDIEM_PATTERN = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const TIME_24H_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const TIME_AROUND_PATTERN = /\b(?:at|around|about)\s+(\d{1,2})(?::([0-5]\d))?\b/i;
const QUIET_PATTERN = /\b(quiet|peaceful|intimate|romantic|ambiance|ambience|conversation)\b|\bto talk\b/i;
const LOUD_PATTERN = /\b(loud|lively|noisy|bustling)\b/i;
const NEGATED_WORD_PATTERN =
  /\b(?:never|not|no|isn't|isnt|aren't|arent|doesn't|doesnt)\s+(?:\w+\s+){0,3}(loud|noisy|lively|quiet|peaceful|intimate)\b/gi;

// Recognizes "browse" phrasing (list/show/recommend/best/top rated ...
// restaurants) so those can be answered directly instead of booked - see
// isListIntent() below. Booking-ish wording always wins over these.
const BOOK_VERB_PATTERN = /\b(book|reserve|reservation)\b/i;
const LIST_VERB_PATTERN = /\b(list|show(?:\s+me)?|what(?:'s| is| are)|which|recommend|suggest|any good)\b/i;
const RATING_PATTERN = /\b(top[-\s]?rated|highest[-\s]?rated|best|most popular|popular|favorite)\b/i;
const RESTAURANT_NOUN_PATTERN = /\b(restaurants?|places?|spots?|options?)\b/i;

/**
 * Drops phrases like "never feels loud" or "not quiet" so a later test for
 * "loud" / "quiet" doesn't treat the negated word as a positive match.
 */
function stripNegations(text: string): string {
  return text.replace(NEGATED_WORD_PATTERN, " ");
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function wordPattern(words: string[]): RegExp {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Turns a clock reading into "HH:MM". Bare hours of 1-11 (no am/pm) are
 * treated as evening, because this app books dinner.
 */
function to24Hour(hour: number, minute: number, meridiem?: string): string | null {
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  let h = hour;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    const isPm = /^p/i.test(meridiem);
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
  } else if (h >= 1 && h <= 11) {
    h += 12;
  }
  return padTime(h, minute);
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + minutes + 24 * 60) % (24 * 60);
  return padTime(Math.floor(total / 60), total % 60);
}

interface PromptFields {
  partySize?: number;
  cuisine?: string;
  area?: string;
  time?: string;
  noise?: "quiet" | "loud";
  restaurantId?: string;
}

/**
 * Pulls structured booking fields out of free text. Only fields that the
 * text actually mentions are set — callers apply defaults themselves.
 */
export function parsePrompt(text: string): PromptFields {
  const cleaned = stripNegations(text);
  const fields: PromptFields = {};

  const party = text.match(PARTY_PATTERN);
  if (party) {
    const size = Number(party[1] ?? party[2]);
    if (size >= 1 && size <= 20) fields.partySize = size;
  }

  const cuisineWords = [...uniqueValues(restaurants.map((r) => r.cuisine)), ...Object.keys(CUISINE_ALIASES)];
  const cuisineMatch = cleaned.match(wordPattern(cuisineWords));
  if (cuisineMatch) {
    const word = cuisineMatch[1].toLowerCase();
    fields.cuisine = CUISINE_ALIASES[word] ?? word;
  }

  const areas = uniqueValues(restaurants.map((r) => r.neighborhood));
  const areaMatch = cleaned.match(wordPattern(areas));
  if (areaMatch) fields.area = areaMatch[1].toLowerCase();

  const meridiem = text.match(TIME_MERIDIEM_PATTERN);
  const clock24 = text.match(TIME_24H_PATTERN);
  const around = text.match(TIME_AROUND_PATTERN);
  if (meridiem) {
    const parsed = to24Hour(Number(meridiem[1]), Number(meridiem[2] ?? "0"), meridiem[3]);
    if (parsed) fields.time = parsed;
  } else if (clock24) {
    const hour = Number(clock24[1]);
    const minute = Number(clock24[2]);
    // "19:30" is already 24-hour. "7:30" with no am/pm is read as evening.
    fields.time = hour > 12 ? padTime(hour, minute) : (to24Hour(hour, minute) ?? undefined);
  } else if (around) {
    const parsed = to24Hour(Number(around[1]), Number(around[2] ?? "0"));
    if (parsed) fields.time = parsed;
  }

  const wantsQuiet = QUIET_PATTERN.test(cleaned);
  const wantsLoud = LOUD_PATTERN.test(cleaned);
  if (wantsQuiet && !wantsLoud) fields.noise = "quiet";
  else if (wantsLoud && !wantsQuiet) fields.noise = "loud";

  const named = restaurants.filter((restaurant) => {
    const escaped = restaurant.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
  if (named.length === 1) fields.restaurantId = named[0].id;

  return fields;
}

/**
 * True for a plain "browse" request - "Can you list top rated restaurants",
 * "What are the best sushi spots", "Show me quiet places downtown" - as
 * opposed to a booking request. Booking-ish wording (a party size, "book",
 * "reserve") always wins, even if the text also contains a list word.
 */
function isListIntent(text: string): boolean {
  if (BOOK_VERB_PATTERN.test(text) || PARTY_PATTERN.test(text)) return false;
  if (!RESTAURANT_NOUN_PATTERN.test(text)) return false;
  return LIST_VERB_PATTERN.test(text) || RATING_PATTERN.test(text);
}

function planFromPrompt(text: string): RegexPlan {
  const fields = parsePrompt(text);
  return {
    partySize: fields.partySize ?? DEFAULT_PARTY_SIZE,
    cuisine: fields.cuisine,
    area: fields.area,
    time: fields.time ?? DEFAULT_TIME,
    noise: fields.noise,
    preferredRestaurantId: fields.restaurantId,
    searchStage: "none",
    candidateIds: [],
    evaluated: {},
    skipped: {},
    proposal: null
  };
}

function setStatus(session: SessionState, status: string | null) {
  session.currentStatus = status;
  touchSession(session);
}

function traceTool(session: SessionState, tool: string, args: Record<string, unknown>, result: unknown) {
  session.trace.push({
    type: "tool_call",
    tool,
    args,
    result,
    timestamp: new Date().toISOString()
  });
  touchSession(session);
}

function runTool(session: SessionState, tool: string, args: Record<string, unknown>, result: unknown) {
  setStatus(session, TOOL_STATUS_MESSAGES[tool] ?? `Running ${tool}...`);
  traceTool(session, tool, args, result);
}

function finish(session: SessionState, message: string, cards: RestaurantCard[] | null = null): LoopResult {
  runTool(session, "finish", { message }, { status: "done" });
  session.done = true;
  session.finalMessage = message;
  session.pendingAsk = null;
  setStatus(session, null);
  return { trace: session.trace, pendingAsk: null, done: true, finalMessage: message, restaurants: cards };
}

function askUser(session: SessionState, restaurant: Restaurant, time: string): LoopResult {
  const plan = session.regexPlan!;
  const later = time !== plan.time;
  const ambiance =
    session.ambianceRequested && plan.noise === "quiet"
      ? " Reviews describe it as quiet enough to talk."
      : session.ambianceRequested && plan.noise === "loud"
        ? " Reviews describe it as lively."
        : "";
  const timeNote = later ? ` ${plan.time} didn't work, so this is 30 minutes later.` : "";
  const message = `I can book ${restaurant.name} (${restaurant.cuisine}, ${restaurant.neighborhood}) for ${plan.partySize} at ${time}.${timeNote}${ambiance} Should I book it?`;

  plan.proposal = { restaurantId: restaurant.id, time };
  const args = { message, restaurant_id: restaurant.id, proposed_time: time };
  runTool(session, "ask_user", args, { status: "waiting_for_user" });

  const pendingAsk = { message, restaurant_id: restaurant.id, proposed_time: time };
  session.pendingAsk = pendingAsk;
  setStatus(session, null);
  return { trace: session.trace, pendingAsk, done: false, finalMessage: null };
}

/**
 * Answers a plain "browse" request (see isListIntent) directly: runs
 * search_places with any cuisine/area mentioned, filters by quiet/loud if
 * asked, annotates each match with tonight's status, and finishes with a
 * short summary plus a `cards` array for the UI to render as a grid (see
 * RestaurantCard in types.ts). There's nothing to approve, so this never
 * calls ask_user and never touches session.regexPlan.
 */
function listRestaurants(session: SessionState): LoopResult {
  const text = session.originalPrompt;
  const fields = parsePrompt(text);

  const args: { cuisine?: string; area?: string } = {};
  if (fields.cuisine) args.cuisine = fields.cuisine;
  if (fields.area) args.area = fields.area;

  const result = tools.search_places(args);
  runTool(session, "search_places", args, result);

  const filtered = fields.noise ? result.restaurants.filter((r) => r.noise === fields.noise) : result.restaurants;

  const cards: RestaurantCard[] = filtered.map((r) => {
    const hoursArgs = { restaurant_id: r.id, time: DEFAULT_TIME };
    const hours = tools.check_hours(hoursArgs);
    runTool(session, "check_hours", hoursArgs, hours);
    const status = "error" in hours ? "operational" : hours.status;
    const openTonight = "error" in hours ? false : Boolean(hours.open_tonight);
    const openHours = "error" in hours ? { open: "", close: "" } : hours.hours;
    return {
      id: r.id,
      name: r.name,
      cuisine: r.cuisine,
      neighborhood: r.neighborhood,
      price: r.price,
      priceRange: r.priceRange,
      rating: r.rating,
      reviewCount: r.reviewCount,
      distanceMiles: r.distanceMiles,
      noise: r.noise,
      status,
      hours: openHours,
      openTonight
    };
  });

  const askedForRating = RATING_PATTERN.test(text);
  cards.sort((a, b) => {
    if (askedForRating) {
      // "top rated"/"best" sorts by (mocked) rating first, independent of
      // tonight's status - the user asked to rank by rating, not by what's
      // bookable right now.
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount;
      return a.name.localeCompare(b.name);
    }
    const aOpen = a.status === "operational" && a.openTonight ? 0 : 1;
    const bOpen = b.status === "operational" && b.openTonight ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return a.name.localeCompare(b.name);
  });

  const filterBits = [fields.cuisine, fields.area, fields.noise].filter(Boolean);
  const filterNote = filterBits.length ? ` matching ${filterBits.join(", ")}` : "";

  if (cards.length === 0) {
    return finish(session, `I couldn't find any restaurants${filterNote}.`);
  }

  // Ratings here are mocked for this demo (see types.ts's Restaurant.rating),
  // not computed from the review text in reviews.json - said plainly rather
  // than implying they're real review scores.
  const disclaimer = askedForRating ? " Ratings are mocked for this demo, not pulled from live reviews." : "";
  const verb = cards.length === 1 ? "is" : "are";
  const noun = cards.length === 1 ? "restaurant" : "restaurants";
  const message = `Here ${verb} ${cards.length} ${noun}${filterNote}.${disclaimer}`;

  return finish(session, message, cards);
}

function searchArgs(plan: RegexPlan, includeArea: boolean): { cuisine?: string; area?: string } {
  const args: { cuisine?: string; area?: string } = {};
  if (plan.cuisine) args.cuisine = plan.cuisine;
  if (includeArea && plan.area) args.area = plan.area;
  return args;
}

function pinPreferred(plan: RegexPlan) {
  const id = plan.preferredRestaurantId;
  if (!id || plan.candidateIds.includes(id)) return;
  plan.candidateIds.unshift(id);
}

function runSearch(session: SessionState, includeArea: boolean) {
  const plan = session.regexPlan!;
  const args = searchArgs(plan, includeArea);
  const result = tools.search_places(args);
  runTool(session, "search_places", args, result);
  for (const restaurant of result.restaurants) {
    if (!plan.candidateIds.includes(restaurant.id)) plan.candidateIds.push(restaurant.id);
  }
  pinPreferred(plan);
}

function ensureCandidates(session: SessionState) {
  const plan = session.regexPlan!;
  if (plan.searchStage !== "none") return;
  const hasArea = Boolean(plan.area);
  runSearch(session, hasArea);
  plan.searchStage = hasArea ? "filtered" : "widened";
}

function widenSearch(session: SessionState): boolean {
  const plan = session.regexPlan!;
  if (plan.searchStage !== "filtered") return false;
  runSearch(session, false);
  plan.searchStage = "widened";
  return true;
}

/**
 * Decides whether review text supports the requested noise level.
 * Negations are removed first so "never feels loud" is not read as "loud".
 * Inconclusive text (neither word shows up) is treated as a match.
 */
function reviewsMatch(reviews: string[], want: "quiet" | "loud"): boolean {
  const cleaned = stripNegations(reviews.join(" "));
  const saysQuiet = QUIET_PATTERN.test(cleaned);
  const saysLoud = LOUD_PATTERN.test(cleaned);
  if (!saysQuiet && !saysLoud) return true;
  if (want === "quiet") return saysQuiet && !saysLoud;
  return saysLoud && !saysQuiet;
}

/**
 * Reviews are only consulted when the original request mentioned ambiance
 * (the read_reviews guardrail enforces that). When review text is available,
 * a regex over that text decides. Otherwise the restaurant's noise field is
 * the fallback.
 */
function ambianceFits(session: SessionState, restaurant: Restaurant): { ok: boolean; reason?: string } {
  const plan = session.regexPlan!;
  if (!plan.noise) return { ok: true };

  if (session.ambianceRequested) {
    const args = { restaurant_id: restaurant.id };
    const result = tools.read_reviews(args, session);
    runTool(session, "read_reviews", args, result);
    if ("reviews" in result && Array.isArray(result.reviews) && !reviewsMatch(result.reviews, plan.noise)) {
      return { ok: false, reason: `reviews don't match a ${plan.noise} meal` };
    }
  }

  if (restaurant.noise !== plan.noise) {
    const wanted = plan.noise === "quiet" ? "a quiet meal" : "a lively meal";
    return { ok: false, reason: `open, but too ${restaurant.noise} for ${wanted}` };
  }

  return { ok: true };
}

function evaluateRestaurant(session: SessionState, restaurantId: string): RegexEvaluation {
  const plan = session.regexPlan!;
  const restaurant = findRestaurant(restaurantId);
  if (!restaurant) return { viableTime: null, reason: "unknown restaurant" };

  const requested = plan.time;
  const later = addMinutes(requested, 30);
  const hoursArgs = { restaurant_id: restaurantId, time: requested };
  const hours = tools.check_hours(hoursArgs);
  runTool(session, "check_hours", hoursArgs, hours);

  if ("error" in hours) return { viableTime: null, reason: String(hours.error) };
  if (hours.status !== "operational") {
    return { viableTime: null, reason: String(hours.status).replace(/_/g, " ") };
  }

  const times = hours.open_tonight ? [requested, later] : [later];
  let lastReason = hours.open_tonight ? `no table at ${requested} or ${later}` : `closed at ${requested} and ${later}`;

  for (const time of times) {
    if (time !== requested) {
      const laterHoursArgs = { restaurant_id: restaurantId, time };
      const laterHours = tools.check_hours(laterHoursArgs);
      runTool(session, "check_hours", laterHoursArgs, laterHours);
      if ("error" in laterHours || !laterHours.open_tonight || laterHours.status !== "operational") {
        lastReason = `closed at ${time}`;
        continue;
      }
    }

    const availArgs = { restaurant_id: restaurantId, party_size: plan.partySize, time };
    const availability = tools.check_availability(availArgs);
    runTool(session, "check_availability", availArgs, availability);

    if ("error" in availability) return { viableTime: null, reason: String(availability.error) };
    if ("blocked" in availability) {
      lastReason = String(availability.reason);
      continue;
    }
    if (availability.status !== "open") {
      lastReason = `no table at ${requested} or ${later}`;
      continue;
    }

    const ambiance = ambianceFits(session, restaurant);
    if (!ambiance.ok) return { viableTime: null, reason: ambiance.reason ?? "ambiance doesn't match" };
    return { viableTime: time, reason: `open at ${time}` };
  }

  return { viableTime: null, reason: lastReason };
}

function evaluatePending(session: SessionState) {
  const plan = session.regexPlan!;
  for (const id of plan.candidateIds) {
    if (plan.skipped[id] || plan.evaluated[id]) continue;
    plan.evaluated[id] = evaluateRestaurant(session, id);
  }
}

function rankScore(plan: RegexPlan, id: string, restaurant: Restaurant): number[] {
  const evaluation = plan.evaluated[id];
  const areaRank = plan.area ? (restaurant.neighborhood.toLowerCase().includes(plan.area) ? 0 : 1) : 0;
  const noiseRank = plan.noise ? (restaurant.noise === plan.noise ? 0 : 1) : 0;
  const timeRank = evaluation?.viableTime === plan.time ? 0 : 1;
  const named = plan.preferredRestaurantId === id ? 0 : 1;
  return [named, areaRank, noiseRank, timeRank];
}

function pickBest(plan: RegexPlan): { restaurant: Restaurant; time: string } | null {
  const viable = plan.candidateIds.filter((id) => plan.evaluated[id]?.viableTime && !plan.skipped[id]);
  viable.sort((a, b) => {
    const ra = findRestaurant(a);
    const rb = findRestaurant(b);
    if (!ra || !rb) return 0;
    const sa = rankScore(plan, a, ra);
    const sb = rankScore(plan, b, rb);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return plan.candidateIds.indexOf(a) - plan.candidateIds.indexOf(b);
  });

  const id = viable[0];
  if (!id) return null;
  const restaurant = findRestaurant(id);
  const time = plan.evaluated[id]?.viableTime;
  if (!restaurant || !time) return null;
  return { restaurant, time };
}

function explainMiss(plan: RegexPlan): string {
  if (plan.candidateIds.length === 0) {
    return "I couldn't find any restaurants matching that request.";
  }
  const parts = plan.candidateIds.map((id) => {
    const name = findRestaurant(id)?.name ?? id;
    if (plan.skipped[id] === "declined") return `${name}: you passed on it`;
    if (plan.skipped[id] === "booking_failed") return `${name}: the booking attempt failed`;
    return `${name}: ${plan.evaluated[id]?.reason ?? "not checked"}`;
  });
  return `I couldn't find a table that fits. ${parts.join(". ")}.`;
}

function bookProposal(session: SessionState, restaurantId: string, time: string): LoopResult | null {
  const stopped = stoppedResult(session);
  if (stopped) return stopped;

  const plan = session.regexPlan!;
  const args = { restaurant_id: restaurantId, party_size: plan.partySize, time };
  const result = tools.book(args, session);
  runTool(session, "book", args, result);

  if (!result.success || !result.booking_id) {
    plan.skipped[restaurantId] = "booking_failed";
    return null;
  }

  const bookingId = result.booking_id;
  const bookedTime = result.time ?? time;
  const name = result.restaurant_name ?? findRestaurant(restaurantId)?.name ?? restaurantId;
  const confirmArgs = { booking_id: bookingId };
  const confirmation = tools.confirm_booking(confirmArgs);
  runTool(session, "confirm_booking", confirmArgs, confirmation);

  if (!confirmation.confirmed) {
    return finish(session, `The booking for ${name} did not confirm. Please try again.`);
  }
  return finish(session, `You're booked at ${name} for ${plan.partySize} at ${bookedTime}. Confirmation ${bookingId}.`);
}

function findAndPropose(session: SessionState): LoopResult {
  const plan = session.regexPlan!;
  ensureCandidates(session);
  evaluatePending(session);

  let best = pickBest(plan);
  if (!best && widenSearch(session)) {
    evaluatePending(session);
    best = pickBest(plan);
  }

  if (!best) return finish(session, explainMiss(plan));
  return askUser(session, best.restaurant, best.time);
}

function applyAnswer(plan: RegexPlan, answer: string) {
  const fields = parsePrompt(answer);
  const changed =
    fields.partySize !== undefined ||
    fields.cuisine !== undefined ||
    fields.area !== undefined ||
    fields.time !== undefined ||
    fields.noise !== undefined ||
    fields.restaurantId !== undefined;

  if (fields.partySize !== undefined) plan.partySize = fields.partySize;
  if (fields.cuisine !== undefined) plan.cuisine = fields.cuisine;
  if (fields.area !== undefined) plan.area = fields.area;
  if (fields.time !== undefined) plan.time = fields.time;
  if (fields.noise !== undefined) plan.noise = fields.noise;
  if (fields.restaurantId !== undefined) plan.preferredRestaurantId = fields.restaurantId;

  if (!changed) return;

  // The old search no longer matches the new constraints.
  plan.candidateIds = [];
  plan.evaluated = {};
  plan.searchStage = "none";
}

/**
 * Runs the local regex planner until it needs a yes/no answer or it is done.
 * On resume, pass the user's raw answer (already recorded by recordUserAnswer).
 */
export async function runRegexLoop(session: SessionState, userAnswer?: string): Promise<LoopResult> {
  const stopped = stoppedResult(session);
  if (stopped) return stopped;

  if (!session.regexPlan) {
    // Only checked on a brand new session, never on resume - so answering
    // "yes"/"no" to a real proposal can't accidentally be re-read as a
    // browse request.
    if (isListIntent(session.originalPrompt)) return listRestaurants(session);
    session.regexPlan = planFromPrompt(session.originalPrompt);
  }
  const plan = session.regexPlan;

  if (plan.proposal) {
    const proposal = plan.proposal;
    plan.proposal = null;
    if (session.approvedRestaurantId === proposal.restaurantId) {
      const booked = bookProposal(session, proposal.restaurantId, proposal.time);
      if (booked) return booked;
    } else {
      plan.skipped[proposal.restaurantId] = "declined";
      if (userAnswer) applyAnswer(plan, userAnswer);
    }
  }

  return findAndPropose(session);
}
