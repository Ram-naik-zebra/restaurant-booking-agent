/**
 * TraceView.tsx
 * -------------
 * The agent's work, shown as short steps (searched, checked hours, read
 * reviews) with the raw tool payload tucked behind a disclosure. The
 * conversation builds one of these for each stretch of tool calls.
 */
import { useEffect, useRef } from "react";
import type { TraceEntry } from "../types";
import { describeStep, placesFrom, reviewsFrom } from "./activityCopy";

interface Props {
  entries: TraceEntry[];
  trace: TraceEntry[];
  // Closed on first paint when the agent has already moved on to a question
  // or a final answer, so that message stays on screen. The user can still open it.
  startClosed?: boolean;
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TraceView({ entries, trace, startClosed = false }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || !detailsRef.current) return;
    seeded.current = true;
    detailsRef.current.open = !startClosed;
  }, [startClosed]);

  if (entries.length === 0) return null;

  const placeNames = [...new Set(entries.flatMap((entry) => placesFrom(entry).map((place) => place.name)))];
  const summaryDetail = placeNames.slice(0, 3).join(", ");

  return (
    <details className="activity" ref={detailsRef}>
      <summary className="activity-summary">
        <span className="activity-caret" aria-hidden="true" />
        <span className="activity-summary-title">Checked {entries.length} {entries.length === 1 ? "step" : "steps"}</span>
        {summaryDetail && <span className="activity-summary-detail">{summaryDetail}</span>}
      </summary>
      <ol className="activity-list">
        {entries.map((entry, index) => {
          const summary = describeStep(entry, trace);
          const places = entry.tool === "search_places" ? placesFrom(entry) : [];
          const reviews = entry.tool === "read_reviews" ? reviewsFrom(entry) : [];
          return (
            <li key={`${entry.tool}-${entry.timestamp}-${index}`} className="activity-step">
              <span className={`step-dot step-dot-${summary.tone}`} aria-hidden="true" />
              <div className="step-main">
                <div className="step-head">
                  <span className="step-title">{summary.title}</span>
                  <time className="step-time" dateTime={entry.timestamp}>
                    {formatStamp(entry.timestamp)}
                  </time>
                </div>
                <p className="step-detail">{summary.detail}</p>
                {places.length > 0 && (
                  <ul className="place-list">
                    {places.map((place) => (
                      <li key={place.id} className="place-card">
                        <span className="place-name">{place.name}</span>
                        <span className="place-meta">{place.meta}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {reviews.length > 0 && (
                  <ul className="review-list">
                    {reviews.map((review, reviewIndex) => (
                      <li key={`${reviewIndex}-${review}`}>{review}</li>
                    ))}
                  </ul>
                )}
                <details className="raw-trace">
                  <summary>Raw tool data · {entry.tool}</summary>
                  <div className="raw-grid">
                    <div>
                      <span>args</span>
                      <pre>{JSON.stringify(entry.args, null, 2)}</pre>
                    </div>
                    <div>
                      <span>result</span>
                      <pre>{JSON.stringify(entry.result, null, 2)}</pre>
                    </div>
                  </div>
                </details>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
