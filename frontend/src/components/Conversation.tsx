/**
 * Conversation.tsx
 * ----------------
 * The scrolling chat. It turns the latest agent response into a thread:
 * your messages, the steps Host took, a proposal when it needs a yes, and
 * the closing note when it's done.
 */
import { useEffect, useRef } from "react";
import { EXAMPLE_PROMPTS } from "../examples";
import type { PendingAsk, RestaurantCard, TraceEntry } from "../types";
import { buildThread, formatClock, lookupRestaurantName, type ThreadItem } from "./activityCopy";
import { ApprovalPanel } from "./ApprovalPanel";
import { HostMark } from "./HostMark";
import { RestaurantResultCard } from "./RestaurantResultCard";
import { TraceView } from "./TraceView";

interface Props {
  utterances: string[];
  trace: TraceEntry[];
  pendingAsk: PendingAsk | null;
  finalMessage: string | null;
  cards: RestaurantCard[] | null;
  done: boolean;
  busy: boolean;
  statusText: string | null;
  error: string | null;
  onAnswer: (answer: string) => void;
  onUseExample: (prompt: string) => void;
}

export function Conversation({ utterances, trace, pendingAsk, finalMessage, cards, done, busy, statusText, error, onAnswer, onUseExample }: Props) {
  const threadRef = useRef<HTMLDivElement>(null);
  const items = buildThread({ utterances, trace, pendingAsk, finalMessage, cards, done, busy, statusText, error });
  const groups = groupItems(items);
  const threadSignature = items.map((item) => (item.type === "thinking" ? "thinking" : item.id)).join("|");

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (utterances.length === 0) {
      el.scrollTo({ top: 0 });
      return;
    }
    const target = el.querySelector(".proposal:not(.proposal-settled)") || el.querySelector(".final-block") || el.querySelector(".thinking");
    if (target instanceof HTMLElement) {
      scrollInside(el, target);
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [threadSignature, utterances.length]);

  return (
    <div className="thread" ref={threadRef}>
      {groups.length === 0 && (
        <div className="greeting">
          <HostMark />
          <div className="greeting-copy">
            <h2>Where should I book tonight?</h2>
            <p>Tell me the party size, cuisine, area, and time. I’ll check what’s actually open, then ask before I reserve anything.</p>
            <div className="suggestion-grid">
              {EXAMPLE_PROMPTS.map((example) => (
                <button key={example.label} type="button" className="suggestion-card" onClick={() => onUseExample(example.prompt)}>
                  <span className="suggestion-label">{example.label}</span>
                  <span className="suggestion-prompt">{example.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {groups.map((group) => {
        if (group.kind === "user") {
          const item = group.items[0];
          if (item.type !== "user") return null;
          return (
            <div key={group.id} className="msg msg-user">
              <div className="user-bubble">
                <span className="sr-only">You said: </span>
                {item.text}
              </div>
            </div>
          );
        }

        if (group.kind === "error") {
          const item = group.items[0];
          if (item.type !== "error") return null;
          return (
            <div key={group.id} className="error-banner" role="alert">
              {item.text}
            </div>
          );
        }

        return (
          <div key={group.id} className="msg msg-agent">
            <HostMark small />
            <div className="msg-body">
              <div className="speaker">Host</div>
              {group.items.map((item, index) => (
                <ThreadPiece
                  key={item.id}
                  item={item}
                  trace={trace}
                  busy={busy}
                  onAnswer={onAnswer}
                  startClosed={index < group.items.length - 1}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function scrollInside(container: HTMLElement, target: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const below = targetRect.bottom - containerRect.bottom;
  const above = containerRect.top - targetRect.top;
  if (below > 0) container.scrollTop += below + 16;
  else if (above > 0) container.scrollTop -= above + 16;
}

function ThreadPiece({
  item,
  trace,
  busy,
  onAnswer,
  startClosed
}: {
  item: ThreadItem;
  trace: TraceEntry[];
  busy: boolean;
  onAnswer: (answer: string) => void;
  startClosed: boolean;
}) {
  if (item.type === "activity") return <TraceView entries={item.entries} trace={trace} startClosed={startClosed} />;

  if (item.type === "proposal") {
    if (item.interactive) {
      return <ApprovalPanel pendingAsk={item.ask} restaurantName={lookupRestaurantName(trace, item.ask.restaurant_id)} onAnswer={onAnswer} disabled={busy} />;
    }
    return (
      <div className="proposal proposal-settled">
        <p className="proposal-kicker">Proposed</p>
        <p className="proposal-message">{item.ask.message}</p>
        <div className="proposal-venue">
          <span className="proposal-venue-name">{lookupRestaurantName(trace, item.ask.restaurant_id)}</span>
          <span className="proposal-venue-time">{formatClock(item.ask.proposed_time)}</span>
        </div>
      </div>
    );
  }

  if (item.type === "thinking") {
    return (
      <div className="thinking" role="status" aria-live="polite">
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {item.status}
      </div>
    );
  }

  if (item.type === "final") {
    return (
      <div className="final-block">
        <p className="final-copy">{item.text}</p>
        {item.cards && item.cards.length > 0 && (
          <div className="restaurant-grid">
            {item.cards.map((card) => (
              <RestaurantResultCard key={card.id} card={card} />
            ))}
          </div>
        )}
        {item.booking && (
          <div className="receipt">
            <p className="receipt-label">{item.booking.confirmed ? "Confirmed" : "Booked"}</p>
            <p className="receipt-name">{item.booking.restaurantName}</p>
            <p className="receipt-meta">
              {item.booking.partySize !== null ? `Party of ${item.booking.partySize}` : "Reservation"}
              {item.booking.time ? ` · ${item.booking.time}` : ""}
            </p>
            {item.booking.bookingId && <p className="receipt-ref">Ref {item.booking.bookingId}</p>}
          </div>
        )}
      </div>
    );
  }

  return null;
}

function groupItems(items: ThreadItem[]): Array<{ id: string; kind: "user" | "agent" | "error"; items: ThreadItem[] }> {
  const groups: Array<{ id: string; kind: "user" | "agent" | "error"; items: ThreadItem[] }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === "user") {
      groups.push({ id: item.id, kind: "user", items: [item] });
      continue;
    }
    if (item.type === "error") {
      groups.push({ id: item.id, kind: "error", items: [item] });
      continue;
    }

    const bundled = [item];
    const next = items[i + 1];
    if (item.type === "activity" && next && (next.type === "proposal" || next.type === "final")) {
      bundled.push(next);
      i += 1;
    }
    groups.push({ id: bundled.map((entry) => entry.id).join("-"), kind: "agent", items: bundled });
  }

  return groups;
}
