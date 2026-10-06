import { useState } from "react";
import { PromptBox } from "./components/PromptBox";
import { TraceView } from "./components/TraceView";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { startAgent, respondToAgent } from "./api";
import type { AgentResponse, PendingAsk, TraceEntry } from "./types";
import "./App.css";

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [finalMessage, setFinalMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyResponse(res: AgentResponse) {
    setSessionId(res.sessionId);
    setTrace(res.trace);
    setPendingAsk(res.pendingAsk);
    setDone(res.done);
    setFinalMessage(res.finalMessage);
  }

  async function handleNewPrompt(prompt: string, forceFailNextBooking: boolean) {
    setBusy(true);
    setError(null);
    setFinalMessage(null);
    setDone(false);
    setPendingAsk(null);
    setTrace([]);
    try {
      const res = await startAgent(prompt, forceFailNextBooking);
      applyResponse(res);
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAnswer(answer: string) {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await respondToAgent(sessionId, answer);
      applyResponse(res);
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const isConversationActive = Boolean(sessionId) && !done;

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Agent</h1>
        <p className="subtitle">An agent that finds a restaurant and books a table - only after you approve.</p>
      </header>

      <PromptBox onSubmit={handleNewPrompt} disabled={busy || isConversationActive} />

      {error && <div className="error-banner">{error}</div>}

      {pendingAsk && <ApprovalPanel pendingAsk={pendingAsk} onAnswer={handleAnswer} disabled={busy} />}

      {done && finalMessage && <div className="final-message">{finalMessage}</div>}

      <section className="trace-section">
        <h2>Agent trace</h2>
        <TraceView trace={trace} />
      </section>
    </div>
  );
}
