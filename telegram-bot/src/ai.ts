/**
 * Claude intent extraction using tool_use for structured output.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContractRecord } from "./store.js";

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

const PAYMENT_SIGNALS =
  /\d+(\.\d+)?\s*(ton|TON)|(?:EQ|UQ)[A-Za-z0-9_-]{46,48}|send|pay|transfer|escrow|release|refund|deploy|contract|deny/i;

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "create_escrow",
    description:
      "Deploy a new TON escrow contract and deposit funds. Use when the user wants to send, pay, or escrow TON to someone.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient: {
          type: "string",
          description: "TON address of the recipient (starts with EQ or UQ)",
        },
        amount: {
          type: "string",
          description: "Amount in TON to deposit (e.g. '0.5')",
        },
        condition: {
          type: "string",
          description:
            "Human-readable condition for releasing the payment (e.g. 'Coffee delivered')",
        },
      },
      required: ["recipient", "amount", "condition"],
    },
  },
  {
    name: "release_escrow",
    description:
      "Release escrowed funds to the recipient. Use when the user wants to release or confirm a payment.",
    input_schema: {
      type: "object" as const,
      properties: {
        contract_address: {
          type: "string",
          description: "Address of the deployed escrow contract",
        },
      },
      required: ["contract_address"],
    },
  },
  {
    name: "refund_escrow",
    description:
      "Refund escrowed funds back to the sender. Use when the user wants to cancel or refund a payment.",
    input_schema: {
      type: "object" as const,
      properties: {
        contract_address: {
          type: "string",
          description: "Address of the deployed escrow contract",
        },
      },
      required: ["contract_address"],
    },
  },
];

const TOOL_TO_ACTION: Record<string, string> = {
  create_escrow: "ton_escrow",
  release_escrow: "ton_release",
  refund_escrow: "ton_refund",
};

function buildSystemPrompt(activeContracts: ContractRecord[]): string {
  let contractContext = "";
  if (activeContracts.length > 0) {
    const list = activeContracts
      .map(
        (c, i) =>
          `${i + 1}. Address: ${c.address} | ${c.amount} TON → ${c.recipient} | Condition: "${c.condition}"`
      )
      .join("\n");
    contractContext = `\n\nActive escrow contracts:\n${list}\n\nWhen the user refers to an escrow by description (e.g. "release the coffee escrow"), match it to the correct contract address above.`;
  }

  return `You are Safe Pay Agent, a TON blockchain payment assistant in a Telegram chat.

You help users create, release, and refund escrow payments on TON testnet.

Rules:
- Only call tools when the user has a clear payment intent with enough information.
- For create_escrow: you need a recipient address, amount, and condition. If any are missing, ask for them conversationally.
- For release/refund: you need to identify which contract. Use the active contracts list to resolve descriptions to addresses.
- If the message is ambiguous or just a question, respond conversationally without calling any tool.
- Keep responses brief and friendly.
- Amounts are in TON (the cryptocurrency).${contractContext}`;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/** Check if a message might contain payment-related content. */
export function hasPaymentSignals(message: string): boolean {
  return PAYMENT_SIGNALS.test(message);
}

/** Extract payment intent from a user message using Claude. */
export async function extractIntent(
  message: string,
  activeContracts: ContractRecord[]
): Promise<IntentResult> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: buildSystemPrompt(activeContracts),
    tools,
    messages: [{ role: "user", content: message }],
  });

  // Check for tool use in the response
  for (const block of response.content) {
    if (block.type === "tool_use") {
      const action = TOOL_TO_ACTION[block.name];
      if (!action) continue;

      const params = block.input as Record<string, unknown>;

      // Build human-readable summary
      let summary: string;
      switch (block.name) {
        case "create_escrow":
          summary = `Deploy escrow: ${params.amount} TON → ${params.recipient}\nCondition: ${params.condition}`;
          break;
        case "release_escrow":
          summary = `Release escrow at ${params.contract_address}`;
          break;
        case "refund_escrow":
          summary = `Refund escrow at ${params.contract_address}`;
          break;
        default:
          summary = `${action}: ${JSON.stringify(params)}`;
      }

      return { type: "tool_call", action, params, summary };
    }
  }

  // No tool call — extract text response
  const textBlocks = response.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text"
  );
  const text =
    textBlocks.map((b) => b.text).join("\n") ||
    "I can help you with TON payments! Try something like: 'Send 0.5 TON to EQ... for coffee'";

  return { type: "text", text };
}
