/**
 * RestaurantResultCard.tsx
 * -------------------------
 * One restaurant card for a "browse" answer (e.g. "list top rated
 * restaurants") - name, rating, distance, price range, noise level, and
 * tonight's hours/status. Purely presentational: every field already came
 * from the backend (see RestaurantCard in types.ts); this never calls the API.
 */
import type { RestaurantCard } from "../types";
import { formatClock, titleCase } from "./activityCopy";

interface Props {
  card: RestaurantCard;
}

function statusLabel(card: RestaurantCard): { text: string; tone: "ok" | "blocked" } {
  if (card.status !== "operational") {
    return { text: titleCase(card.status.replaceAll("_", " ")), tone: "blocked" };
  }
  if (!card.openTonight) return { text: "Closed for tonight", tone: "blocked" };
  const span = card.hours.open && card.hours.close ? `${formatClock(card.hours.open)} – ${formatClock(card.hours.close)}` : "";
  return { text: span ? `Open tonight · ${span}` : "Open tonight", tone: "ok" };
}

export function RestaurantResultCard({ card }: Props) {
  const status = statusLabel(card);
  return (
    <div className="restaurant-card">
      <div className="restaurant-card-head">
        <span className="restaurant-card-name">{card.name}</span>
        <span className="restaurant-card-rating" title={`${card.reviewCount} reviews`}>
          ★ {card.rating.toFixed(1)}
          <span className="restaurant-card-review-count"> ({card.reviewCount})</span>
        </span>
      </div>
      <p className="restaurant-card-meta">
        {titleCase(card.cuisine)} · {titleCase(card.neighborhood)} · {card.distanceMiles.toFixed(1)} mi
      </p>
      <p className="restaurant-card-meta">
        {card.priceRange} · {card.noise === "quiet" ? "Quiet" : "Lively"}
      </p>
      <span className={`restaurant-card-status restaurant-card-status-${status.tone}`}>{status.text}</span>
    </div>
  );
}
