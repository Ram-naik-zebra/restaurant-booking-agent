import { useState } from "react";

interface Props {
  onSubmit: (prompt: string, forceFailNextBooking: boolean) => void;
  disabled: boolean;
}

const EXAMPLES = ["Table for 4, Italian, near Downtown, tonight around 7 PM, quiet enough to talk.", "Any sushi nearby for 2 tonight."];

export function PromptBox({ onSubmit, disabled }: Props) {
  const [prompt, setPrompt] = useState("");
  const [forceFail, setForceFail] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    onSubmit(prompt.trim(), forceFail);
  }

  return (
    <form className="prompt-box" onSubmit={handleSubmit}>
      <textarea
        placeholder="e.g. Table for 4, Italian, near Downtown, tonight around 7 PM, quiet enough to talk."
        value={prompt}
        disabled={disabled}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
      />
      <div className="prompt-box-row">
        <label className="force-fail-toggle">
          <input type="checkbox" checked={forceFail} disabled={disabled} onChange={(e) => setForceFail(e.target.checked)} />
          Force next booking attempt to fail (dev toggle)
        </label>
        <button type="submit" className="btn btn-primary" disabled={disabled || !prompt.trim()}>
          {disabled ? "Working..." : "Send"}
        </button>
      </div>
      <div className="prompt-examples">
        Try:{" "}
        {EXAMPLES.map((ex, i) => (
          <button type="button" key={i} className="example-chip" disabled={disabled} onClick={() => setPrompt(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </form>
  );
}
