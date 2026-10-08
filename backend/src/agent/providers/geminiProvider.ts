/**
 * geminiProvider.ts
 * -----------------
 * The LLM provider used in production: talks to Google's Gemini API (free
 * tier available, needs a GEMINI_API_KEY - see https://aistudio.google.com/app/apikey).
 *
 * Gemini's function-calling API has a different shape than OpenAI/Ollama's
 * (different field names, different roles, etc.), so this file's main job is
 * TRANSLATION: converting our shared ChatMessage/ToolSchema types (see
 * types.ts) into Gemini's Content/FunctionDeclaration format, and converting
 * Gemini's response back into our shared LlmChatResult format - so
 * agent/loop.ts never has to know or care which provider it's actually
 * talking to.
 *
 * Implements the shared LlmProvider interface (see types.ts).
 */

import { GoogleGenerativeAI, FunctionDeclaration, Content, Part } from "@google/generative-ai";
import { ChatMessage, ToolSchema, LlmChatResult, LlmProvider } from "../../types";

// Gemini has its own native function-calling shape, different from OpenAI's
// tool_calls - this provider converts our shared ChatMessage/ToolSchema
// types into Gemini's Content/FunctionDeclaration format and back, so
// loop.ts never has to know which provider it's talking to.
export class GeminiProvider implements LlmProvider {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  /**
   * Sets up the Gemini SDK client using the GEMINI_API_KEY env var.
   * Throws immediately (on construction, before any API call) if no key is
   * set, so the error is obvious rather than failing later mid-conversation.
   */
  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey");
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    // gemini-3.8-flash is the only generally-available flash model left for
    // new API keys as of late 2026 - older models 404 with "no longer
    // available to new users".
    this.modelName = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  }

  /**
   * Sends the full conversation so far, plus the list of available tools,
   * to Gemini, and returns either the tool call(s) it wants to make, or
   * plain text content.
   *
   * @param messages - the full conversation history in our shared ChatMessage format
   * @param tools - the list of tools the model is allowed to call (see toolSchemas.ts)
   * @returns { toolCalls: [...] } if the model chose to call one or more
   *   tools, otherwise { content: "..." } (Gemini is forced via toolConfig
   *   below to basically always choose a tool call, same as Ollama's
   *   tool_choice: "required", except Gemini actually honors it reliably)
   */
  async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<LlmChatResult> {
    // Gemini wants the "system" instructions passed separately from the
    // regular conversation turns, via systemInstruction - not as a normal message.
    const systemMessage = messages.find((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemMessage?.content ?? undefined,
      tools: [{ functionDeclarations: tools.map(toGeminiFunctionDeclaration) }],
      // "ANY" forces the model to always call one of the provided functions,
      // mirroring tool_choice="required" - unlike Ollama, Gemini reliably
      // honors this, which is exactly why production uses Gemini.
      toolConfig: { functionCallingConfig: { mode: "ANY" as any } },
    });

    const contents: Content[] = conversation.map(toGeminiContent);

    const result = await generateContentWithRetry(model, contents);
    const parts: Part[] = result.response.candidates?.[0]?.content?.parts ?? [];

    const functionCallParts = parts.filter((p): p is Part & { functionCall: NonNullable<Part["functionCall"]> } =>
      Boolean(p.functionCall),
    );

    if (functionCallParts.length > 0) {
      return {
        toolCalls: functionCallParts.map((p, i) => ({
          id: `call_${Date.now()}_${i}`,
          name: p.functionCall.name,
          arguments: (p.functionCall.args as Record<string, any>) ?? {},
          // Newer "thinking" Gemini models attach an opaque thoughtSignature
          // to functionCall parts - capture it here so it can be echoed back
          // on the next turn (see toGeminiContent below), as required by
          // https://ai.google.dev/gemini-api/docs/thought-signatures.
          thoughtSignature: (p as any).thoughtSignature,
        })),
      };
    }

    const text = parts
      .map((p) => p.text)
      .filter((t): t is string => Boolean(t))
      .join("\n");
    return { content: text };
  }
}

// Gemini returns 503 "high demand"/overload errors fairly often for popular
// models, and these are almost always transient - a short retry-with-backoff
// clears them up without surfacing a scary error to the end user. We only
// retry on 503 (and generic transient network blips); 4xx errors (bad key,
// bad model name, bad request) fail fast since retrying won't help.
/**
 * Calls model.generateContent(...), automatically retrying with exponential
 * backoff if the failure looks transient (503 overloaded, 429 rate limited,
 * or a generic network "fetch failed"). Non-transient errors (bad API key,
 * bad model name, malformed request) are NOT retried - they fail immediately
 * since trying again wouldn't help.
 *
 * @param model - the Gemini model instance returned by genAI.getGenerativeModel(...)
 * @param contents - the conversation turns to send, in Gemini's Content[] format
 * @param maxRetries - how many extra attempts to make after the first try (default 3)
 * @returns whatever model.generateContent(...) resolves to, on the first successful attempt
 * @throws the last error encountered, if every attempt (including retries) fails
 */
async function generateContentWithRetry(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  contents: Content[],
  maxRetries = 3,
) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent({ contents });
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const isRetryable = status === 503 || status === 429 || err?.message?.includes("fetch failed");
      if (!isRetryable || attempt === maxRetries) throw err;
      const delayMs = 500 * 2 ** attempt; // 500ms, 1s, 2s, 4s
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Converts one of our shared ToolSchema objects into Gemini's
 * FunctionDeclaration format. Gemini's shape happens to be almost identical
 * to ours, so this is a near-trivial field rename/pass-through.
 * @param tool - one tool schema from toolSchemas.ts
 * @returns the equivalent Gemini FunctionDeclaration object
 */
function toGeminiFunctionDeclaration(tool: ToolSchema): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as any,
  };
}

/**
 * Converts one of our shared ChatMessage objects into Gemini's Content
 * format. Three cases, same as ollamaProvider's toOpenAiMessage:
 *   - a tool result message -> Gemini's functionResponse part
 *   - an assistant message that called tools -> Gemini's functionCall part(s)
 *   - a plain text message -> Gemini's plain text part
 * @param m - one message from our shared conversation history
 * @returns the equivalent Gemini Content object
 */
function toGeminiContent(m: ChatMessage): Content {
  if (m.role === "tool") {
    // The API used to accept role: "function" for returning tool/function
    // results, but newer API versions reject it ("Role 'function' is not
    // supported") - function responses now go back as a "user" turn instead.
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: m.name ?? "unknown",
            response: safeParseJson(m.content ?? "{}"),
          },
        },
      ],
    };
  }

  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "model",
      parts: m.tool_calls.map((tc) => ({
        functionCall: { name: tc.name, args: tc.arguments },
        // Echo back the thoughtSignature captured from the original response
        // (see geminiProvider.chat above) - required by the API when present,
        // otherwise omitted so plain function calls still work.
        ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
      })),
    };
  }

  return {
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content ?? "" }],
  };
}

/**
 * Parses a JSON string, returning an empty object instead of throwing if
 * parsing fails (used for the content of tool-result messages, which we
 * stored as JSON text in agent/loop.ts).
 * @param raw - the raw JSON string to parse
 * @returns the parsed object, or {} if parsing failed
 */
function safeParseJson(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
