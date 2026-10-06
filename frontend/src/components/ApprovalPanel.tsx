import { useState } from "react";
import type { PendingAsk } from "../types";

interface Props {
  pendingAsk: PendingAsk;
  onAnswer: (answer: string) => void;
  disabled: boolean;
}

export function ApprovalPanel({ pendingAsk, onAnswer, disabled }: Props) {
  const [customAnswer, setCustomAnswer] = useState("");

  return (
    <div className="approval-panel">
      <p className="approval-message">{pendingAsk.message}</p>
      <p className="approval-meta">
        Proposing <strong>{pendingAsk.restaurant_id}</strong> at <strong>{pendingAsk.proposed_time}</strong>
      </p>
      <div className="approval-buttons">
        <button className="btn btn-yes" disabled={disabled} onClick={() => onAnswer("yes")}>
          Yes, book it
        </button>
        <button className="btn btn-no" disabled={disabled} onClick={() => onAnswer("no")}>
          No, keep looking
        </button>
      </div>
      <form
        className="approval-custom"
        onSubmit={(e) => {
          e.preventDefault();
          if (customAnswer.trim()) {
            onAnswer(customAnswer.trim());
            setCustomAnswer("");
          }
        }}
      >
        <input
          type="text"
          placeholder="Or type a custom reply..."
          value={customAnswer}
          disabled={disabled}
          onChange={(e) => setCustomAnswer(e.target.value)}
        />
        <button type="submit" className="btn" disabled={disabled || !customAnswer.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
