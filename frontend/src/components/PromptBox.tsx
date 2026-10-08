/**
 * PromptBox.tsx
 * -------------
 * The composer pinned under the chat. It collects the next request, the
 * regex/LLM choice, and the dev "simulate a failure" toggle, then hands
 * them to App. It does not talk to the backend itself.
 */
import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { EXAMPLE_PROMPTS } from "../examples";
import type { AgentEngine } from "../types";

interface Props {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: (prompt: string, forceFailNextBooking: boolean, engine: AgentEngine) => void;
  engine: AgentEngine;
  onEngineChange: (engine: AgentEngine) => void;
  disabled: boolean;
  placeholder: string;
  showExamples: boolean;
}

export function PromptBox({ prompt, onPromptChange, onSubmit, engine, onEngineChange, disabled, placeholder, showExamples }: Props) {
  const [forceFail, setForceFail] = useState(false);

  function submit() {
    if (disabled || !prompt.trim()) return;
    onSubmit(prompt.trim(), forceFail, engine);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {showExamples && (
        <div className="example-row">
          {EXAMPLE_PROMPTS.map((example) => (
            <button key={example.label} type="button" className="example-chip" disabled={disabled} onClick={() => onPromptChange(example.prompt)}>
              {example.label}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        <label className="sr-only" htmlFor="agent-prompt">
          Message Host
        </label>
        <textarea
          id="agent-prompt"
          placeholder={placeholder}
          value={prompt}
          disabled={disabled}
          rows={2}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" className="send-btn" disabled={disabled || !prompt.trim()} aria-label={disabled ? "Working" : "Send"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="composer-tools">
        <div className="mode-toggle" role="radiogroup" aria-label="Search mode">
          <button
            type="button"
            role="radio"
            aria-checked={engine === "regex"}
            className={engine === "regex" ? "mode-btn mode-btn-active" : "mode-btn"}
            disabled={disabled}
            onClick={() => onEngineChange("regex")}
          >
            Local regex
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={engine === "llm"}
            className={engine === "llm" ? "mode-btn mode-btn-active" : "mode-btn"}
            disabled={disabled}
            onClick={() => onEngineChange("llm")}
          >
            LLM
          </button>
        </div>
        <label
          className="force-fail-toggle"
          title="A one-time test. The next booking attempt fails on purpose so Host offers another restaurant."
        >
          <input type="checkbox" checked={forceFail} disabled={disabled} onChange={(e) => setForceFail(e.target.checked)} />
          Test a failed booking
        </label>
      </div>
      <p className="composer-note">
        {engine === "regex"
          ? "Local regex reads the request on this machine. Nothing is booked until you approve a table."
          : "Each step goes to the configured model. Nothing is booked until you approve a table."}
      </p>
    </form>
  );
}
