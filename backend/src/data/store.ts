import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Restaurant, Slot, Review, BookingLogEntry } from "../types";

import restaurantsJson from "./restaurants.json";
import slotsJson from "./slots.json";
import reviewsJson from "./reviews.json";

export const restaurants: Restaurant[] = restaurantsJson as Restaurant[];
export const slots: Slot[] = slotsJson as Slot[];
export const reviews: Review[] = reviewsJson as Review[];

const BOOKING_LOG_PATH = path.join(__dirname, "bookingLog.json");

function loadBookingLog(): BookingLogEntry[] {
  try {
    const raw = fs.readFileSync(BOOKING_LOG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

let bookingLog: BookingLogEntry[] = loadBookingLog();

function persistBookingLog() {
  try {
    fs.writeFileSync(BOOKING_LOG_PATH, JSON.stringify(bookingLog, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal: in-memory log still works even if disk write fails (e.g. read-only fs)
    console.warn("Could not persist booking log to disk:", err);
  }
}

export function findRestaurant(id: string): Restaurant | undefined {
  return restaurants.find((r) => r.id === id);
}

/**
 * Resolves a restaurant_id value that might actually be the restaurant's
 * NAME (small/local LLMs sometimes pass "Trattoria Rosso" instead of "r1"
 * even when the parameter is correctly named restaurant_id). Falls back to
 * the input unchanged if no match is found, so callers can still surface a
 * clear "unknown restaurant" error.
 */
export function resolveRestaurantId(value: string | undefined): string | undefined {
  if (!value) return value;
  if (findRestaurant(value)) return value;
  const byName = restaurants.find((r) => r.name.toLowerCase() === value.toLowerCase());
  return byName ? byName.id : value;
}

export function findSlot(restaurantId: string, partySize: number, time: string): Slot | undefined {
  return slots.find((s) => s.restaurant_id === restaurantId && s.party_size === partySize && s.time === time);
}

export function reviewsFor(restaurantId: string): Review[] {
  return reviews.filter((r) => r.restaurant_id === restaurantId);
}

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

export function findBooking(bookingId: string): BookingLogEntry | undefined {
  return bookingLog.find((b) => b.booking_id === bookingId);
}
