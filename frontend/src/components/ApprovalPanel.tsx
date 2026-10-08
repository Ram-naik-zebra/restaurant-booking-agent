/**
 * ApprovalPanel.tsx
 * -----------------
 * The pause in the chat where Host proposes one table and waits. Rendered
 * only for the ask that still needs an answer. "Yes, book it" sends the
 * string "yes", which is what the backend treats as approval.
 */
import { useState } from "react";
import type { PendingAsk } from "../types";
import { formatClock } from "./activityCopy";

interface Props {
  pendingAsk: PendingAsk;
  restaurantName: string;
  onAnswer: (answer: string) => void;
  disabled: boolean;
}

export function ApprovalPanel({ pendingAsk, restaurantName, onAnswer, disabled }: Props) {
  const [customAnswer, setCustomAnswer] = useState("");

  return (
    <div className="proposal" role="region" aria-label="Approval needed">
      <p className="proposal-kicker">Waiting for you</p>
      <p className="proposal-message">{pendingAsk.message}</p>
      <div className="proposal-venue">
        <span className="proposal-venue-name">{restaurantName}</span>
        <span className="proposal-venue-time">{formatClock(pendingAsk.proposed_time)}</span>
      </div>
      <div className="approval-buttons">
        <button type="button" className="btn btn-yes" disabled={disabled} onClick={() => onAnswer("yes")}>
          Yes, book it
        </button>
        <button type="button" className="btn btn-no" disabled={disabled} onClick={() => onAnswer("no")}>
          No, keep looking
        </button>
      </div>
      <form
        className="approval-custom"
        onSubmit={(e) => {
          e.preventDefault();
          if (!customAnswer.trim()) return;
          onAnswer(customAnswer.trim());
          setCustomAnswer("");
        }}
      >
        <input
          type="text"
          placeholder="Or tell me to try a different time or place…"
          value={customAnswer}
          disabled={disabled}
          onChange={(e) => setCustomAnswer(e.target.value)}
        />
        <button type="submit" className="btn btn-ghost" disabled={disabled || !customAnswer.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
