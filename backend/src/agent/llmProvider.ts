/**
 * llmProvider.ts
 * --------------
 * This file is a tiny "factory": it picks and builds the correct LLM
 * provider (Ollama for local dev, Gemini for production) based on the
 * LLM_PROVIDER environment variable, and hands back an object that
 * implements the shared LlmProvider interface (see types.ts).
 *
 * The rest of the codebase (mainly agent/loop.ts) only ever calls
 * getLlmProvider() and then uses `.chat(...)` on the result - it never
 * needs an if/else for "which provider am I using", because both
 * OllamaProvider and GeminiProvider expose the exact same `chat()` method
 * shape. This is the "provider" or "adapter" pattern.
 */

import { ChatMessage, ToolSchema, LlmChatResult, LlmProvider } from "../types";

// Re-export these types so other files can `import { LlmProvider } from "./llmProvider"`
// instead of reaching into "../types" directly - purely a convenience re-export, no logic.
export type { LlmProvider, LlmChatResult };

/**
 * Reads the LLM_PROVIDER environment variable and returns a ready-to-use
 * LlmProvider instance:
 *   - LLM_PROVIDER=gemini  -> GeminiProvider (used in production)
 *   - anything else (default) -> OllamaProvider (used for local dev)
 *
 * No arguments. Returns: an object with a `.chat(messages, tools)` method.
 */
export function getLlmProvider(): LlmProvider {
  const provider = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
  if (provider === "gemini") {
    // Lazy-require so the Ollama-only dev path never needs the Gemini SDK installed/configured.
    const { GeminiProvider } = require("./providers/geminiProvider");
    return new GeminiProvider();
  }
  const { OllamaProvider } = require("./providers/ollamaProvider");
  return new OllamaProvider();
}

export type { ChatMessage, ToolSchema };
