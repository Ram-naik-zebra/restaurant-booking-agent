/**
 * ollamaProvider.ts
 * -----------------
 * The LLM provider used for local development: talks to Ollama (a tool
 * that runs open-source LLMs like llama3.1 on your own machine, for free,
 * with no API key).
 *
 * Ollama happens to expose an API that's compatible with OpenAI's chat/tool
 * calling format, so instead of writing our own HTTP calls, we just reuse
 * the official `openai` npm package and point it at Ollama's local address
 * (OLLAMA_BASE_URL) instead of OpenAI's real servers.
 *
 * Implements the shared LlmProvider interface (see types.ts), so
 * agent/loop.ts can use this interchangeably with GeminiProvider.
 */

import OpenAI from "openai";
import { ChatMessage, ToolSchema, LlmChatResult, LlmProvider } from "../../types";

// Ollama exposes an OpenAI-compatible endpoint, including tool_calls, so we
// can reuse the official `openai` SDK just by pointing baseURL at Ollama and
// using any placeholder api key (Ollama ignores it).
export class OllamaProvider implements LlmProvider {
  private client: OpenAI;
  private model: string;

  /**
   * Sets up the OpenAI SDK client pointed at the local Ollama server, using
   * OLLAMA_BASE_URL and OLLAMA_MODEL from backend/.env (with sensible
   * defaults if those aren't set).
   */
  constructor() {
    const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
    this.model = process.env.OLLAMA_MODEL || "llama3.1:8b";
    this.client = new OpenAI({ baseURL, apiKey: "ollama" });
  }

  /**
   * Sends the full conversation so far, plus the list of available tools,
   * to the local Ollama model, and returns either the tool call(s) it wants
   * to make, or (rarely, since we force tool use below) plain text.
   *
   * @param messages - the full conversation history in our shared ChatMessage format
   * @param tools - the list of tools the model is allowed to call (see toolSchemas.ts)
   * @returns { toolCalls: [...] } if the model chose to call one or more
   *   tools, otherwise { content: "..." } if it replied with plain text
   */
  async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LlmChatResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => toOpenAiMessage(m)) as any,
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      })) as any,
      // "required" forces the model to always call a tool, never reply with
      // bare prose - this is what makes `finish`/`ask_user` the only ways to
      // communicate with the user (see systemPrompt.ts's MANDATORY RULE).
      tool_choice: "required"
    });

    const choice = response.choices[0];
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        toolCalls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseJson(tc.function.arguments)
        }))
      };
    }

    return { content: msg.content ?? "" };
  }
}

/**
 * Converts one of our shared ChatMessage objects into the exact shape the
 * OpenAI SDK (and therefore Ollama's compatible API) expects to send over
 * the wire. Three cases: a tool result, an assistant message that called
 * tools, or a plain message (system/user/assistant with just text).
 * @param m - one message from our shared conversation history
 * @returns the equivalent OpenAI-format chat message object
 */
function toOpenAiMessage(m: ChatMessage) {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? "" };
  }
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      }))
    };
  }
  return { role: m.role, content: m.content ?? "" };
}

/**
 * Parses a JSON string, returning an empty object instead of throwing if the
 * model produced malformed JSON for its tool call arguments (which small
 * local models occasionally do).
 * @param raw - the raw arguments string from the model's tool call
 * @returns the parsed object, or {} if parsing failed
 */
function safeParseJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
