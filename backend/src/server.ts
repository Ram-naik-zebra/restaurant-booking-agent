/**
 * server.ts
 * ---------
 * This is the entry point of the backend: it starts an Express web server
 * and exposes a small HTTP API that the frontend (React app) talks to.
 *
 * It does NOT contain any of the "agent" logic itself (deciding which tool
 * to call, running tools, etc.). That lives in agent/loop.ts for the LLM
 * and agent/regexEngine.ts for the local regex mode. This file is just the
 * thin HTTP layer on top: receive a request, hand it to the chosen engine,
 * send back the result as JSON.
 *
 * Routes exposed:
 *   GET  /api/health                     - simple "is the server up" check
 *   GET  /api/agent/status/:sessionId    - poll "what's happening right now" for a session
 *   POST /api/agent/start                - start a brand new conversation
 *   POST /api/agent/respond              - answer a pending ask_user question
 *   POST /api/agent/abort                - ask the running loop to stop
 */

import "dotenv/config"; // loads variables from backend/.env into process.env
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { abortSession, createSession, getSession } from "./agent/sessionStore";
import { runAgentLoop, recordUserAnswer, LoopResult } from "./agent/loop";
import { runRegexLoop } from "./agent/regexEngine";
import { promptMentionsAmbiance } from "./agent/tools";
import { AgentEngine, SessionState } from "./types";

// Create the Express application - this object is what actually listens
// for incoming HTTP requests and routes them to the handlers below.
const app = express();

// Built-in Express middleware: automatically parses incoming JSON request
// bodies into plain JS objects, available as `req.body` in every handler below.
app.use(express.json());

// CORS = Cross-Origin Resource Sharing. By default, browsers block a web
// page served from one origin (e.g. http://localhost:5173, our Vite
// frontend) from calling an API on a different origin (e.g.
// http://localhost:4000, this server). This middleware explicitly allows
// the origins listed in the CORS_ORIGIN env var (comma-separated) to call us.
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins }));

/**
 * GET /api/health
 * Trivial endpoint with no real logic - just lets you (or a deployment
 * platform's health check) confirm the server process is up and responding.
 */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function parseEngine(value: unknown): AgentEngine {
  return value === "regex" ? "regex" : "llm";
}

/**
 * Continues a session with whichever engine it was started with. Regex
 * sessions never call a model; LLM sessions use the provider in llmProvider.ts.
 */
async function continueSession(session: SessionState, userAnswer?: string): Promise<LoopResult> {
  if (session.engine === "regex") return runRegexLoop(session, userAnswer);
  return runAgentLoop(session);
}

// Lightweight polling endpoint so the frontend can show live "what's
// happening" text while a /start or /respond request is still in flight on
// the server (those endpoints only resolve once the whole agent loop - which
// may take several LLM turns - has finished).
/**
 * GET /api/agent/status/:sessionId
 * Lets the frontend ask "what is the agent doing right now, for this
 * session?" while a slower /start or /respond request is still running.
 * Returns a short human-readable status string (or null if there isn't one
 * right now, e.g. the session doesn't exist yet or has finished).
 */
app.get("/api/agent/status/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  // Not found just means the session hasn't been created yet (e.g. the
  // frontend started polling a hair before /start reached the server) or has
  // since expired - not an error worth surfacing to the UI.
  if (!session) return res.json({ status: null });
  res.json({ status: session.currentStatus });
});

/**
 * POST /api/agent/start
 * Starts a brand new conversation from a free-text user prompt (e.g.
 * "book me a quiet Italian table for 4 at 7pm downtown").
 *
 * Request body: { prompt: string, forceFailNextBooking?: boolean, sessionId?: string, engine?: "llm" | "regex" }
 *   - prompt: the user's free-text request (required)
 *   - forceFailNextBooking: testing helper - if true, the very next `book`
 *     tool call will simulate a failure, to exercise the "retry a different
 *     restaurant" behavior without needing real-world flakiness
 *   - sessionId: optional client-generated id, so the frontend can start
 *     polling /api/agent/status/:sessionId immediately, before this request finishes
 *   - engine: "regex" runs the local pattern matcher; anything else uses the LLM
 *
 * Response body: { sessionId, trace, pendingAsk, done, finalMessage }
 *   (the shape returned by runAgentLoop, see agent/loop.ts)
 */
app.post("/api/agent/start", async (req, res) => {
  try {
    const { prompt, forceFailNextBooking, sessionId: clientSessionId, engine: requestedEngine } = req.body as {
      prompt?: string;
      forceFailNextBooking?: boolean;
      sessionId?: string;
      engine?: string;
    };

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Missing 'prompt' string in request body." });
    }

    // Prefer a client-generated id (lets the frontend start polling
    // /api/agent/status/:sessionId for live progress before this request
    // finishes) but fall back to generating one for backward compatibility.
    const sessionId = clientSessionId || uuidv4();
    const engine = parseEngine(requestedEngine);
    const session = createSession(sessionId, prompt, promptMentionsAmbiance(prompt), engine);
    session.forceFailNextBooking = Boolean(forceFailNextBooking);
    session.messages.push({ role: "user", content: prompt });

    // "regex" stays on this machine (agent/regexEngine.ts). "llm" asks the
    // model which tool to call next (agent/loop.ts).
    const result = await continueSession(session);
    res.json({ sessionId, engine: session.engine, ...result });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

// Resume a paused conversation with the user's answer to the last ask_user question.
/**
 * POST /api/agent/respond
 * Resumes a conversation that is currently paused on an ask_user question
 * (i.e. session.pendingAsk is set) - called when the human clicks "Yes" or
 * "No" in the UI's approval panel.
 *
 * Request body: { sessionId: string, answer: string }
 *   - answer should be exactly "yes" to approve the pending proposal;
 *     anything else (including "no") is treated as a rejection - see
 *     recordUserAnswer in agent/loop.ts for the exact matching rule.
 *
 * Response body: same shape as /api/agent/start (the loop continues running
 * from where it left off, and may pause again on another ask_user, or finish).
 */
app.post("/api/agent/respond", async (req, res) => {
  try {
    const { sessionId, answer } = req.body as { sessionId?: string; answer?: string };
    if (!sessionId || typeof answer !== "string") {
      return res.status(400).json({ error: "Missing 'sessionId' or 'answer' in request body." });
    }

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired." });
    if (!session.pendingAsk) return res.status(400).json({ error: "This session has no pending question." });

    // Record whether the user said "yes" (this is what actually grants
    // approval to book - see the comment on recordUserAnswer in loop.ts).
    recordUserAnswer(session, answer);
    // Let the same engine keep going now that it has the user's answer.
    const result = await continueSession(session, answer);
    res.json({ sessionId, engine: session.engine, ...result });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

/**
 * POST /api/agent/abort
 * Asks a running conversation to stop before its next tool call. Safe to
 * call with a session id that /start has not created yet.
 */
app.post("/api/agent/abort", (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing 'sessionId' in request body." });
  }
  abortSession(sessionId);
  res.json({ ok: true });
});

// Which network port to listen on - Render (and most hosts) set PORT via an
// env var; 4000 is just our local-dev default.
const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Restaurant agent backend listening on http://localhost:${PORT}`);
  console.log(`LLM_PROVIDER=${process.env.LLM_PROVIDER || "ollama"}`);
});
