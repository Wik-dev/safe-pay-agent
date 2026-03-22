/**
 * Claude intent extraction using tool_use for structured output.
 * Tools, keywords, and summaries are all driven by the catalog.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Catalog } from "./catalog.js";
import type { ResultRecord } from "./store.js";

export interface PaymentIntent {
  type: "tool_call";
  action: string;
  params: Record<string, unknown>;
  summary: string;
}

export interface ConversationalResponse {
  type: "text";
  text: string;
}

export type IntentResult = PaymentIntent | ConversationalResponse;

let catalog: Catalog;
let tools: Anthropic.Messages.Tool[];
let keywordPattern: RegExp;

/** Initialize AI layer with a loaded catalog. */
export function initAI(cat: Catalog): void {
  catalog = cat;
  tools = cat.buildTools();
  keywordPattern = cat.buildKeywordPattern();
}

/** Check if a message might contain action-related content. */
export function hasPaymentSignals(message: string): boolean {
  return keywordPattern.test(message);
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/** Extract intent from a user message using Claude. */
export async function extractIntent(
  message: string,
  activeResults: ResultRecord[]
): Promise<IntentResult> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: catalog.buildSystemPrompt(activeResults),
    tools,
    messages: [{ role: "user", content: message }],
  });

  for (const block of response.content) {
    if (block.type === "tool_use") {
      const action = block.name;
      if (!catalog.template(action)) continue;

      const params = block.input as Record<string, unknown>;
      const summary = catalog.formatSummary(action, params);

      return { type: "tool_call", action, params, summary };
    }
  }

  const textBlocks = response.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text"
  );
  const text =
    textBlocks.map((b) => b.text).join("\n") ||
    "I can help you with that! Tell me what you'd like to do.";

  return { type: "text", text };
}
