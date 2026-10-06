import { GoogleGenerativeAI, FunctionDeclaration, Content, Part } from "@google/generative-ai";
import { ChatMessage, ToolSchema, LlmChatResult, LlmProvider } from "../../types";

// Gemini has its own native function-calling shape, different from OpenAI's
// tool_calls - this provider converts our shared ChatMessage/ToolSchema
// types into Gemini's Content/FunctionDeclaration format and back, so
// loop.ts never has to know which provider it's talking to.
export class GeminiProvider implements LlmProvider {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey");
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LlmChatResult> {
    const systemMessage = messages.find((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemMessage?.content ?? undefined,
      tools: [{ functionDeclarations: tools.map(toGeminiFunctionDeclaration) }],
      // "ANY" forces the model to always call one of the provided functions,
      // mirroring tool_choice="required" - unlike Ollama, Gemini reliably
      // honors this, which is exactly why production uses Gemini.
      toolConfig: { functionCallingConfig: { mode: "ANY" as any } }
    });

    const contents: Content[] = conversation.map(toGeminiContent);

    const result = await model.generateContent({ contents });
    const parts: Part[] = result.response.candidates?.[0]?.content?.parts ?? [];

    const functionCallParts = parts.filter((p): p is Part & { functionCall: NonNullable<Part["functionCall"]> } => Boolean(p.functionCall));

    if (functionCallParts.length > 0) {
      return {
        toolCalls: functionCallParts.map((p, i) => ({
          id: `call_${Date.now()}_${i}`,
          name: p.functionCall.name,
          arguments: (p.functionCall.args as Record<string, any>) ?? {}
        }))
      };
    }

    const text = parts
      .map((p) => p.text)
      .filter((t): t is string => Boolean(t))
      .join("\n");
    return { content: text };
  }
}

function toGeminiFunctionDeclaration(tool: ToolSchema): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as any
  };
}

function toGeminiContent(m: ChatMessage): Content {
  if (m.role === "tool") {
    return {
      role: "function",
      parts: [
        {
          functionResponse: {
            name: m.name ?? "unknown",
            response: safeParseJson(m.content ?? "{}")
          }
        }
      ]
    };
  }

  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "model",
      parts: m.tool_calls.map((tc) => ({ functionCall: { name: tc.name, args: tc.arguments } }))
    };
  }

  return {
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content ?? "" }]
  };
}

function safeParseJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
