import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createSession, getSession } from "./agent/sessionStore";
import { runAgentLoop, recordUserAnswer } from "./agent/loop";
import { promptMentionsAmbiance } from "./agent/tools";

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
app.use(cors({ origin: allowedOrigins }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Start a brand new conversation with a free-text prompt.
app.post("/api/agent/start", async (req, res) => {
  try {
    const { prompt, forceFailNextBooking } = req.body as { prompt?: string; forceFailNextBooking?: boolean };
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Missing 'prompt' string in request body." });
    }

    const sessionId = uuidv4();
    const session = createSession(sessionId, prompt, promptMentionsAmbiance(prompt));
    session.forceFailNextBooking = Boolean(forceFailNextBooking);
    session.messages.push({ role: "user", content: prompt });

    const result = await runAgentLoop(session);
    res.json({ sessionId, ...result });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

// Resume a paused conversation with the user's answer to the last ask_user question.
app.post("/api/agent/respond", async (req, res) => {
  try {
    const { sessionId, answer } = req.body as { sessionId?: string; answer?: string };
    if (!sessionId || typeof answer !== "string") {
      return res.status(400).json({ error: "Missing 'sessionId' or 'answer' in request body." });
    }

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found or expired." });
    if (!session.pendingAsk) return res.status(400).json({ error: "This session has no pending question." });

    recordUserAnswer(session, answer);
    const result = await runAgentLoop(session);
    res.json({ sessionId, ...result });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Restaurant agent backend listening on http://localhost:${PORT}`);
  console.log(`LLM_PROVIDER=${process.env.LLM_PROVIDER || "ollama"}`);
});
