# AI Agent - Agentic Restaurant Booking

One AI agent finds a restaurant and books a table - only after you approve. The agentic behavior lives *inside* the agent: at every step it decides the next tool to call based on the previous tool's result, not a hard-coded pipeline.

Phase 1 (this version): everything runs against a fake, simulated "city" (JSON files) - no real Maps/OpenTable APIs yet. See [`.cursor/plans`](.cursor/plans) history for the full plan and the phase 2 research notes on real data providers.

## Architecture

- `backend/` - Node + Express + TypeScript. Holds the agent loop, the 7 tools, the fake-city data, and the LLM provider adapter (Ollama locally, Gemini in production).
- `frontend/` - React + Vite + TypeScript. One page: a prompt box, a live trace of every tool call/result, and a yes/no approval panel before booking.

```
backend/src/
  server.ts              Express app: /api/agent/start, /api/agent/respond
  agent/
    loop.ts              The agentic loop (LLM -> tool -> result -> LLM -> ...)
    llmProvider.ts        Provider-agnostic interface
    providers/
      ollamaProvider.ts    Local dev LLM (Ollama, OpenAI-compatible tool calling)
    toolSchemas.ts          JSON-schema definitions for the 7 tools
    systemPrompt.ts          Agent goal + behavioral guidance (not a forced order)
    tools.ts                 Tool implementations + the 3 hard safety guardrails
    sessionStore.ts           In-memory session state (pause/resume for ask_user)
  data/
    restaurants.json, slots.json, reviews.json   The fake city
    store.ts                                      Data access + booking log persistence
frontend/src/
  App.tsx                 Page layout
  api.ts                   Fetch wrappers
  components/
    PromptBox.tsx, TraceView.tsx, ApprovalPanel.tsx
```

## Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com) installed and running locally, with a tool-calling-capable model pulled:

```powershell
ollama pull llama3.1:8b
```

(Other tool-calling models like `qwen2.5:7b` also work - just update `OLLAMA_MODEL` in `backend/.env`.)

## Running locally

**1. Backend**

```powershell
cd backend
npm install
copy .env.example .env   # defaults to LLM_PROVIDER=ollama, no key needed
npm run dev
```

Backend listens on `http://localhost:4000`.

**2. Frontend** (new terminal)

```powershell
cd frontend
npm install
copy .env.example .env
npm run dev
```

Frontend runs on `http://localhost:5173`.

Make sure Ollama is running (`ollama serve`, or it's already running as a background service) before sending a prompt.

## Try it

- `"Table for 4, Italian, near Downtown, tonight around 7 PM, quiet enough to talk."` - triggers the 7:30 fallback (7:00 is full) and calls `read_reviews` because ambiance was mentioned.
- `"Any sushi nearby for 2 tonight."` - no ambiance mentioned, so `read_reviews` is never called; two open matches trigger the "pick one, explain why, ask" branch.
- Party of 6, quiet Italian downtown - exercises the neighborhood fallback (downtown full at both times, midtown has room).
- Party of 8, quiet Italian downtown - exercises the "stop and explain" dead end (nothing available anywhere).
- Check "Force next booking to fail" before answering "yes" - exercises the booking-failure -> propose-next-candidate branch.

Watch the **Agent trace** panel: each entry shows the tool called, its arguments, and its result, so you can confirm the branch behavior by reading the trace rather than the code.

## Guardrails (hold regardless of what the LLM decides)

Three rules are enforced in `tools.ts` itself, not just as prompt suggestions:

1. `check_availability` refuses to run (returns `blocked: "closed"`) if the restaurant is closed for the night OR closed as a business (temporarily/permanently) - a closed place never gets a simulated reservation call.
2. `read_reviews` refuses (returns `skipped: ...`) unless the original prompt mentioned ambiance/noise/quiet/loud/talk - reviews are never read if ambiance wasn't asked about.
3. `book` refuses (returns `success: false`) unless the session recorded a prior `ask_user` "yes" for that exact restaurant - nothing is ever booked before approval, independent of what the LLM tries to do.

## Known limitations (phase 1, by design)

- All restaurant/hours/review data is fake JSON, not live APIs (see Phase 2 notes above).
- Sessions are in-memory and reset if the backend process restarts.
- `backend/src/data/bookingLog.json` is written at runtime and gitignored.
