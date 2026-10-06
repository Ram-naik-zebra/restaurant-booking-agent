import { ChatMessage, ToolSchema, LlmChatResult, LlmProvider } from "../types";

export type { LlmProvider, LlmChatResult };

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
