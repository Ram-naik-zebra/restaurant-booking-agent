import OpenAI from "openai";
import { ChatMessage, ToolSchema, LlmChatResult, LlmProvider } from "../../types";

// Ollama exposes an OpenAI-compatible endpoint, including tool_calls, so we
// can reuse the official `openai` SDK just by pointing baseURL at Ollama and
// using any placeholder api key (Ollama ignores it).
export class OllamaProvider implements LlmProvider {
  private client: OpenAI;
  private model: string;

  constructor() {
    const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
    this.model = process.env.OLLAMA_MODEL || "llama3.1:8b";
    this.client = new OpenAI({ baseURL, apiKey: "ollama" });
  }

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

function safeParseJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
