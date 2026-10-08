/**
 * activityCopy.ts
 * ---------------
 * Turns the backend's tool trace into the lines, place cards, and
 * reservation summary the chat shows. This file only describes tool
 * results that already came back from the backend.
 */
import type { PendingAsk, RestaurantCard, TraceEntry } from "../types";

export type StepTone = "ok" | "blocked" | "skipped" | "fail" | "neutral";

export interface StepCopy {
  title: string;
  detail: string;
  tone: StepTone;
}

export interface PlaceSummary {
  id: string;
  name: string;
  meta: string;
}

export interface BookingReceipt {
  restaurantName: string;
  partySize: number | null;
  time: string;
  bookingId: string;
  confirmed: boolean;
}

export type ThreadItem =
  | { type: "user"; id: string; text: string }
  | { type: "activity"; id: string; entries: TraceEntry[] }
  | { type: "proposal"; id: string; ask: PendingAsk; answer: string | null; interactive: boolean }
  | { type: "thinking"; id: string; status: string }
  | { type: "final"; id: string; text: string; booking: BookingReceipt | null; cards: RestaurantCard[] | null }
  | { type: "error"; id: string; text: string };

export function formatClock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = match[2];
  if (!Number.isInteger(hours) || hours > 23) return value;
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes} ${suffix}`;
}

export function titleCase(value: string): string {
  return value.replace(/(^|\s)\w/g, (char) => char.toUpperCase());
}

export function displayAnswer(answer: string): string {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "yes") return "Yes, book it";
  if (normalized === "no") return "No, keep looking";
  return answer;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

/** Finds a restaurant's display name from earlier tool results. Falls back to the id. */
export function lookupRestaurantName(trace: TraceEntry[], id: string): string {
  if (!id) return "";
  for (let i = trace.length - 1; i >= 0; i--) {
    const result = record(trace[i].result);
    if (!result) continue;
    if (Array.isArray(result.restaurants)) {
      for (const place of result.restaurants) {
        const row = record(place);
        if (row && row.id === id && typeof row.name === "string") return row.name;
      }
    }
    const samePlace = result.restaurant_id === id || trace[i].args?.restaurant_id === id;
    if (samePlace && typeof result.restaurant_name === "string") return result.restaurant_name;
    if (samePlace && typeof result.name === "string") return result.name;
  }
  return id;
}

export function placesFrom(entry: TraceEntry): PlaceSummary[] {
  const result = record(entry.result);
  if (!result || !Array.isArray(result.restaurants)) return [];
  return result.restaurants.flatMap((place) => {
    const row = record(place);
    if (!row || typeof row.name !== "string") return [];
    const meta = [text(row.cuisine) ? titleCase(text(row.cuisine)) : "", text(row.neighborhood) ? titleCase(text(row.neighborhood)) : "", text(row.price), text(row.noise)]
      .filter(Boolean)
      .join(" · ");
    return [{ id: text(row.id) || row.name, name: row.name, meta }];
  });
}

export function reviewsFrom(entry: TraceEntry): string[] {
  const result = record(entry.result);
  if (!result || !Array.isArray(result.reviews)) return [];
  return result.reviews.filter((item): item is string => typeof item === "string");
}

function placeName(entry: TraceEntry, trace: TraceEntry[]): string {
  const id = text(entry.args?.restaurant_id);
  return id ? lookupRestaurantName(trace, id) : "";
}

/** One-line description of a single tool call, plus a color tone for the step dot. */
export function describeStep(entry: TraceEntry, trace: TraceEntry[]): StepCopy {
  const args = entry.args ?? {};
  const result = record(entry.result) ?? {};
  const name = placeName(entry, trace);

  switch (entry.tool) {
    case "search_places": {
      const cuisine = text(args.cuisine) ? titleCase(text(args.cuisine)) : "";
      const area = text(args.area) ? titleCase(text(args.area)) : "";
      let title = "Searched the city";
      if (cuisine && area) title = `Searched for ${cuisine} near ${area}`;
      else if (cuisine) title = `Searched for ${cuisine}`;
      else if (area) title = `Searched near ${area}`;
      let count: number | null = null;
      if (typeof result.count === "number") count = result.count;
      else if (Array.isArray(result.restaurants)) count = result.restaurants.length;
      const names = Array.isArray(result.restaurants)
        ? result.restaurants.flatMap((place) => {
            const row = record(place);
            return row && typeof row.name === "string" ? [row.name] : [];
          })
        : [];
      const listed = names.slice(0, 3).join(", ");
      const extra = names.length > 3 ? ` +${names.length - 3}` : "";
      let detail = "Search finished";
      if (count === 0) detail = "Nothing matched";
      else if (listed) detail = `${listed}${extra}`;
      else if (count !== null) detail = `${count} places`;
      return { title, detail, tone: count === 0 ? "neutral" : "ok" };
    }
    case "check_hours": {
      if (text(result.error)) return { title: name ? `Checked hours at ${name}` : "Checked hours", detail: text(result.error), tone: "fail" };
      const hours = record(result.hours);
      const span = hours ? `${formatClock(text(hours.open))}–${formatClock(text(hours.close))}` : "";
      const status = text(result.status).replaceAll("_", " ");
      let detail = "Checked";
      let tone: StepTone = "neutral";
      if (status && status !== "operational") {
        detail = titleCase(status);
        tone = "blocked";
      } else if (result.open_tonight === false) {
        detail = "Closed at that time";
        tone = "blocked";
      } else if (result.open_tonight === true) {
        detail = span ? `Open tonight · ${span}` : "Open tonight";
        tone = "ok";
      }
      return { title: name ? `Checked hours at ${name}` : "Checked hours", detail, tone };
    }
    case "check_availability": {
      const when = text(args.time) ? formatClock(text(args.time)) : "";
      const party = text(args.party_size) ? ` for ${text(args.party_size)}` : "";
      const title = `Checked a table${party}${when ? ` at ${when}` : ""}`;
      if (result.blocked) return { title, detail: text(result.reason) || `Blocked: ${text(result.blocked)}`, tone: "blocked" };
      if (text(result.error)) return { title, detail: text(result.error), tone: "fail" };
      let availability = text(result.status) || "Checked";
      let tone: StepTone = "fail";
      if (result.status === "open") {
        availability = "A table is open";
        tone = "ok";
      } else if (result.status === "full") {
        availability = "Fully booked";
        tone = "blocked";
      }
      return { title, detail: name ? `${name} · ${availability}` : availability, tone };
    }
    case "read_reviews": {
      const title = name ? `Read reviews for ${name}` : "Read reviews";
      if (result.skipped) return { title, detail: "Skipped — noise wasn’t part of the request", tone: "skipped" };
      if (text(result.error)) return { title, detail: text(result.error), tone: "fail" };
      const count = Array.isArray(result.reviews) ? result.reviews.length : 0;
      return { title, detail: count === 1 ? "1 recent note" : `${count} recent notes`, tone: "ok" };
    }
    case "book": {
      if (result.success === true) {
        const booked = text(result.restaurant_name) || name || "the table";
        const bits = [typeof result.party_size === "number" ? `Party of ${result.party_size}` : "", text(result.time) ? formatClock(text(result.time)) : ""].filter(Boolean);
        return { title: `Booked ${booked}`, detail: bits.join(" · ") || "Reservation created", tone: "ok" };
      }
      return { title: name ? `Couldn’t book ${name}` : "Couldn’t book", detail: text(result.error) || "The booking didn’t go through", tone: "fail" };
    }
    case "confirm_booking": {
      if (result.confirmed === true) {
        const booking = record(result.booking);
        const ref = text(booking?.booking_id);
        return { title: "Confirmed the reservation", detail: ref ? `Ref ${ref}` : "It’s on the books", tone: "ok" };
      }
      return { title: "Couldn’t confirm the reservation", detail: text(result.reason) || "Not found", tone: "fail" };
    }
    default: {
      let detail = "Finished";
      let tone: StepTone = "neutral";
      if (result.blocked) {
        detail = `Blocked: ${text(result.blocked)}`;
        tone = "blocked";
      } else if (result.skipped) {
        detail = `Skipped: ${text(result.skipped)}`;
        tone = "skipped";
      } else if (result.success === false) {
        detail = text(result.error) || "Failed";
        tone = "fail";
      } else if (result.success === true) {
        detail = "Succeeded";
        tone = "ok";
      }
      return { title: titleCase(entry.tool.replaceAll("_", " ")), detail, tone };
    }
  }
}

function receiptFrom(trace: TraceEntry[]): BookingReceipt | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const entry = trace[i];
    if (entry.tool !== "book") continue;
    const result = record(entry.result);
    if (!result || result.success !== true) continue;
    const confirmed = trace.slice(i + 1).some((later) => {
      if (later.tool !== "confirm_booking") return false;
      return record(later.result)?.confirmed === true;
    });
    const restaurantId = text(result.restaurant_id);
    return {
      restaurantName: text(result.restaurant_name) || lookupRestaurantName(trace, restaurantId),
      partySize: typeof result.party_size === "number" ? result.party_size : null,
      time: formatClock(text(result.time)),
      bookingId: text(result.booking_id),
      confirmed
    };
  }
  return null;
}

function askFromEntry(entry: TraceEntry): PendingAsk {
  return {
    message: text(entry.args?.message),
    restaurant_id: text(entry.args?.restaurant_id),
    proposed_time: text(entry.args?.proposed_time)
  };
}

/**
 * Folds the server trace and the user's own messages into chat items.
 * ask_user becomes a proposal, finish is omitted (the final message covers it),
 * and everything else stays in order as activity between those pauses.
 */
export function buildThread(input: {
  utterances: string[];
  trace: TraceEntry[];
  pendingAsk: PendingAsk | null;
  finalMessage: string | null;
  cards: RestaurantCard[] | null;
  done: boolean;
  busy: boolean;
  statusText: string | null;
  error: string | null;
}): ThreadItem[] {
  const { utterances, trace, pendingAsk, finalMessage, cards, done, busy, statusText, error } = input;
  const items: ThreadItem[] = [];

  if (utterances[0]) items.push({ type: "user", id: "user-0", text: utterances[0] });

  let activity: TraceEntry[] = [];
  let askIndex = 0;

  const flushActivity = () => {
    if (activity.length === 0) return;
    items.push({ type: "activity", id: `activity-${items.length}`, entries: activity });
    activity = [];
  };

  for (const entry of trace) {
    if (entry.tool === "finish") {
      flushActivity();
      continue;
    }
    if (entry.tool === "ask_user") {
      flushActivity();
      const answer = utterances[askIndex + 1] ?? null;
      const interactive = answer === null && !busy && pendingAsk !== null;
      items.push({
        type: "proposal",
        id: `ask-${askIndex}`,
        ask: interactive && pendingAsk ? pendingAsk : askFromEntry(entry),
        answer,
        interactive
      });
      if (answer !== null) {
        items.push({ type: "user", id: `user-${askIndex + 1}`, text: displayAnswer(answer) });
      }
      askIndex += 1;
      continue;
    }
    activity.push(entry);
  }
  flushActivity();

  if (busy) {
    items.push({ type: "thinking", id: "thinking", status: statusText || "Working on your request…" });
  }

  if (done && finalMessage) {
    items.push({ type: "final", id: "final", text: finalMessage, booking: receiptFrom(trace), cards: cards && cards.length ? cards : null });
  }

  if (error) items.push({ type: "error", id: "error", text: error });

  return items;
}
