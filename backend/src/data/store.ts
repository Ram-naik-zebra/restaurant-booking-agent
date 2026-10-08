/**
 * store.ts
 * --------
 * This file is our fake "database". Phase 1 of this project uses plain JSON
 * files instead of a real database or real APIs (see restaurants.json,
 * slots.json, reviews.json) - this file loads that JSON into memory once at
 * startup, and exposes simple lookup/query functions over it (findRestaurant,
 * findSlot, reviewsFor, etc.) so the rest of the code never touches the raw
 * JSON files directly.
 *
 * The one piece of "real" persistence here is the booking log: every
 * successful booking is appended to backend/src/data/bookingLog.json on
 * disk, so bookings survive a server restart (unlike sessions, which are
 * only in memory - see sessionStore.ts).
 */

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Restaurant, Slot, Review, BookingLogEntry } from "../types";

import restaurantsJson from "./restaurants.json";
import slotsJson from "./slots.json";
import reviewsJson from "./reviews.json";

// The fake city's data, loaded once into memory and typed according to
// types.ts. These are exported as plain arrays - read-only in practice,
// even though TypeScript doesn't enforce that here.
export const restaurants: Restaurant[] = restaurantsJson as Restaurant[];
export const slots: Slot[] = slotsJson as Slot[];
export const reviews: Review[] = reviewsJson as Review[];

// Where we persist successful bookings on disk (gitignored - see .gitignore -
// so each developer/deployment accumulates their own local booking history).
const BOOKING_LOG_PATH = path.join(__dirname, "bookingLog.json");

/**
 * Reads bookingLog.json from disk into memory, if it exists.
 * @returns the array of past bookings, or an empty array if the file
 *   doesn't exist yet or can't be parsed (e.g. first run ever).
 */
function loadBookingLog(): BookingLogEntry[] {
  try {
    const raw = fs.readFileSync(BOOKING_LOG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// In-memory copy of the booking log, loaded once at startup and kept in sync
// with the file via persistBookingLog() every time a new booking is added.
let bookingLog: BookingLogEntry[] = loadBookingLog();

/**
 * Writes the current in-memory bookingLog array back out to disk, so
 * bookings aren't lost when the server restarts. Called automatically by
 * createBooking() - you should never need to call this directly.
 */
function persistBookingLog() {
  try {
    fs.writeFileSync(BOOKING_LOG_PATH, JSON.stringify(bookingLog, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal: in-memory log still works even if disk write fails (e.g. read-only fs)
    console.warn("Could not persist booking log to disk:", err);
  }
}

/**
 * Looks up a single restaurant by its exact id (e.g. "r1").
 * @param id - the restaurant's id field
 * @returns the matching Restaurant object, or undefined if no restaurant has that id
 */
export function findRestaurant(id: string): Restaurant | undefined {
  return restaurants.find((r) => r.id === id);
}

/**
 * Resolves a restaurant_id value that might actually be the restaurant's
 * NAME (small/local LLMs sometimes pass "Trattoria Rosso" instead of "r1"
 * even when the parameter is correctly named restaurant_id). Falls back to
 * the input unchanged if no match is found, so callers can still surface a
 * clear "unknown restaurant" error.
 *
 * @param value - whatever string the LLM passed as a restaurant_id argument
 *   (could be a real id like "r1", a restaurant name, or something invalid)
 * @returns the correct id if we could figure it out, otherwise the original
 *   value unchanged (so the caller's own "unknown restaurant_id" check still
 *   produces a sensible error message)
 */
export function resolveRestaurantId(value: string | undefined): string | undefined {
  if (!value) return value;
  if (findRestaurant(value)) return value; // already a valid id - nothing to do
  const byName = restaurants.find((r) => r.name.toLowerCase() === value.toLowerCase());
  return byName ? byName.id : value;
}

/**
 * Looks up whether a specific table slot (restaurant + party size + time)
 * exists in our fake availability data, and what its status is.
 * @param restaurantId - which restaurant
 * @param partySize - how many people
 * @param time - "HH:MM" 24h time string
 * @returns the matching Slot (with status "open" or "full"), or undefined if
 *   no such slot was ever defined in slots.json (callers treat "undefined" as
 *   "full" - see check_availability in tools.ts)
 */
export function findSlot(restaurantId: string, partySize: number, time: string): Slot | undefined {
  return slots.find((s) => s.restaurant_id === restaurantId && s.party_size === partySize && s.time === time);
}

/**
 * Gets every fake review written for a given restaurant.
 * @param restaurantId - which restaurant
 * @returns an array of Review objects for that restaurant (empty array if none)
 */
export function reviewsFor(restaurantId: string): Review[] {
  return reviews.filter((r) => r.restaurant_id === restaurantId);
}

/**
 * Records a new successful booking: creates a BookingLogEntry with a fresh
 * random booking_id, appends it to the in-memory log, and saves the log to
 * disk. Called from the `book` tool in tools.ts once a booking has been approved.
 *
 * @param restaurantId - which restaurant was booked
 * @param partySize - how many people
 * @param time - "HH:MM" 24h time string
 * @returns the newly created BookingLogEntry (includes the generated booking_id)
 */
export function createBooking(restaurantId: string, partySize: number, time: string): BookingLogEntry {
  const entry: BookingLogEntry = {
    booking_id: uuidv4(),
    restaurant_id: restaurantId,
    party_size: partySize,
    time,
    created_at: new Date().toISOString()
  };
  bookingLog.push(entry);
  persistBookingLog();
  return entry;
}

/**
 * Looks up a past booking by its booking_id, used by the confirm_booking
 * tool to verify a booking actually exists before telling the user it's confirmed.
 * @param bookingId - the booking_id returned by createBooking/the `book` tool
 * @returns the matching BookingLogEntry, or undefined if no such booking exists
 */
export function findBooking(bookingId: string): BookingLogEntry | undefined {
  return bookingLog.find((b) => b.booking_id === bookingId);
}
