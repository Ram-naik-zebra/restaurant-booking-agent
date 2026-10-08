/**
 * examples.ts
 * -----------
 * Starter requests shown in the empty chat and, after a finished
 * conversation, as chips in the composer. Display-only.
 */

export const EXAMPLE_PROMPTS = [
  {
    label: "Quiet Italian for 4",
    prompt: "Table for 4, Italian, near Downtown, tonight around 7 PM, quiet enough to talk."
  },
  {
    label: "Sushi for 2",
    prompt: "Any sushi nearby for 2 tonight."
  },
  {
    label: "List top rated restaurants",
    prompt: "Can you list top rated restaurants downtown?"
  }
] as const;
