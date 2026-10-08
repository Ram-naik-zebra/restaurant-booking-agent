/**
 * App.tsx
 * -------
 * The chat shell. It owns one conversation with the booking agent and
 * lays it out as a thread plus a composer:
 *   - Conversation  - messages, live steps, the approval card, the result
 *   - PromptBox     - the next request, pinned to the bottom
 *
 * This file calls api.ts to talk to the backend. It never calls fetch itself.
 */
import { useRef, useState } from "react";
import { Conversation } from "./components/Conversation";
import { HostMark } from "./components/HostMark";
import { PromptBox } from "./components/PromptBox";
import { abortAgent, getAgentStatus, respondToAgent, startAgent } from "./api";
import type { AgentEngine, AgentResponse, PendingAsk, RestaurantCard, TraceEntry } from "./types";
import "./App.css";

const STATUS_POLL_INTERVAL_MS = 1000;

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [finalMessage, setFinalMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [engine, setEngine] = useState<AgentEngine>("regex");
  // Set only on "browse" answers (e.g. "list top rated restaurants") - see
  // Conversation's cards prop, rendered as a grid instead of plain text.
  const [resultCards, setResultCards] = useState<RestaurantCard[] | null>(null);
  const [utterances, setUtterances] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [stopped, setStopped] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightSessionRef = useRef<string | null>(null);
  // Bumped on every new request and on "New chat", so a late response from
  // an abandoned request can't paint over the conversation you switched to.
  const requestRef = useRef(0);

  function applyResponse(res: AgentResponse) {
    setSessionId(res.sessionId);
    setTrace(res.trace);
    setPendingAsk(res.pendingAsk);
    setDone(res.done);
    setFinalMessage(res.finalMessage);
    if (res.engine) setEngine(res.engine);
    setResultCards(res.restaurants ?? null);
  }

  function stopStatusPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setStatusText(null);
  }

  function startStatusPolling(id: string, initialText: string) {
    stopStatusPolling();
    setStatusText(initialText);
    pollRef.current = setInterval(async () => {
      try {
        const { status } = await getAgentStatus(id);
        if (status) setStatusText(status);
      } catch {
        // A missed poll just leaves the last status line in place.
      }
    }, STATUS_POLL_INTERVAL_MS);
  }

  function isCurrent(id: number) {
    return requestRef.current === id;
  }

  function cancelInflight() {
    const sessionToStop = inflightSessionRef.current;
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inflightSessionRef.current = null;
    stopStatusPolling();
    if (sessionToStop) abortAgent(sessionToStop).catch(() => {});
    return sessionToStop;
  }

  function handleReset() {
    cancelInflight();
    setSessionId(null);
    setTrace([]);
    setPendingAsk(null);
    setFinalMessage(null);
    setDone(false);
    setBusy(false);
    setStopped(false);
    setError(null);
    setUtterances([]);
    setDraft("");
    setResultCards(null);
  }

  function handleStop() {
    if (!busy) return;
    cancelInflight();
    setBusy(false);
    setPendingAsk(null);
    setDone(true);
    setStopped(true);
    setError(null);
    setFinalMessage("Stopped. I didn't keep going.");
  }

  async function handleNewPrompt(prompt: string, forceFailNextBooking: boolean, selectedEngine: AgentEngine) {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError(null);
    setFinalMessage(null);
    setDone(false);
    setPendingAsk(null);
    setTrace([]);
    setSessionId(null);
    setStopped(false);
    setResultCards(null);
    setUtterances([prompt]);
    setEngine(selectedEngine);
    const newSessionId = crypto.randomUUID();
    inflightSessionRef.current = newSessionId;
    const controller = new AbortController();
    abortRef.current = controller;
    startStatusPolling(newSessionId, selectedEngine === "regex" ? "Reading your request with local regex…" : "Reading your request…");
    try {
      const res = await startAgent(newSessionId, prompt, forceFailNextBooking, selectedEngine, controller.signal);
      if (!isCurrent(requestId)) return;
      applyResponse(res);
      setDraft("");
    } catch (err: unknown) {
      if (!isCurrent(requestId)) return;
      setDraft(prompt);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      if (isCurrent(requestId)) {
        stopStatusPolling();
        setBusy(false);
      }
    }
  }

  async function handleAnswer(answer: string) {
    if (!sessionId) return;
    const requestId = ++requestRef.current;
    setBusy(true);
    setError(null);
    setStopped(false);
    setUtterances((prev) => [...prev, answer]);
    inflightSessionRef.current = sessionId;
    const controller = new AbortController();
    abortRef.current = controller;
    startStatusPolling(sessionId, "Sending your answer…");
    try {
      const res = await respondToAgent(sessionId, answer, controller.signal);
      if (!isCurrent(requestId)) return;
      applyResponse(res);
    } catch (err: unknown) {
      if (!isCurrent(requestId)) return;
      setUtterances((prev) => prev.slice(0, -1));
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      if (isCurrent(requestId)) {
        stopStatusPolling();
        setBusy(false);
      }
    }
  }

  const awaitingApproval = pendingAsk !== null;
  const canCompose = !busy && !awaitingApproval;
  const phase = error ? "error" : busy ? "working" : awaitingApproval ? "waiting" : done ? "done" : "idle";
  const statusLabel = stopped
    ? "Stopped"
    : phase === "working"
      ? statusText || "Working…"
      : phase === "waiting"
        ? "Waiting for you"
        : phase === "done"
          ? "Request complete"
          : phase === "error"
            ? "Needs attention"
            : "Ready to book";
  const placeholder = awaitingApproval ? "Reply to the proposal above" : done ? "Ask for another table" : "Table for 4, Italian, downtown, 7 PM, quiet enough to talk";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <HostMark />
          <div className="brand-copy">
            <h1>Table Tonight</h1>
            <p className="brand-status">
              <span className={`status-dot status-${phase}`} aria-hidden="true" />
              <span className="brand-status-text">{statusLabel}</span>
            </p>
          </div>
        </div>
        <div className="topbar-actions">
          {busy && (
            <button type="button" className="stop-chat" onClick={handleStop}>
              Stop
            </button>
          )}
          {utterances.length > 0 && (
            <button type="button" className="new-chat" onClick={handleReset}>
              New chat
            </button>
          )}
        </div>
      </header>

      <Conversation
        utterances={utterances}
        trace={trace}
        pendingAsk={pendingAsk}
        finalMessage={finalMessage}
        cards={resultCards}
        done={done}
        busy={busy}
        statusText={busy ? statusText : null}
        error={error}
        onAnswer={handleAnswer}
        onUseExample={setDraft}
      />

      <PromptBox
        prompt={draft}
        onPromptChange={setDraft}
        onSubmit={handleNewPrompt}
        engine={engine}
        onEngineChange={setEngine}
        disabled={!canCompose}
        placeholder={placeholder}
        showExamples={canCompose && utterances.length > 0}
      />
    </div>
  );
}
