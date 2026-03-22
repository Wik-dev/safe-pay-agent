/**
 * Grammy bot — message handlers, approval buttons, callback queries.
 */

import { Bot, InlineKeyboard } from "grammy";
import crypto from "node:crypto";
import type { Catalog } from "./catalog.js";
import { extractIntent, hasPaymentSignals, recordToolResult } from "./ai.js";
import { ValidanceClient, type ProposalRequest } from "./validance.js";
import {
  addResult,
  addPending,
  getActiveResults,
  getAllResults,
  pendingProposals,
  updateResult,
  type ProposalResult,
} from "./store.js";
import {
  formatApprovalRequest,
  formatResultHistory,
  formatError,
  formatResult,
} from "./format.js";
import type { OnApprovalReady } from "./webhook.js";

const CANNED_RESPONSE = `I'm Safe Pay Agent — I help you execute validated actions.

Try something like:
\u2022 "Send 0.5 TON to EQ... for coffee delivery"
\u2022 "Release the coffee escrow"
\u2022 "Check balance of EQ..."

Or use /results to see your history.`;

export function createBot(
  token: string,
  validance: ValidanceClient,
  webhookHost: string,
  webhookPort: number,
  catalog: Catalog
): { bot: Bot; onApprovalReady: OnApprovalReady } {
  const bot = new Bot(token);

  // Session hash: SHA256("tg:" + chatId) for Validance rate limits + audit
  function sessionHash(chatId: number): string {
    return crypto
      .createHash("sha256")
      .update(`tg:${chatId}`)
      .digest("hex");
  }

  // --- Commands ---

  bot.command("start", async (ctx) => {
    await ctx.reply(
      `<b>Safe Pay Agent</b>\n\nI help you execute validated actions via natural language.\n\nJust describe what you want to do, and I'll handle the rest.\n\n<b>Commands:</b>\n/results \u2014 List your results\n/help \u2014 How to use me`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("contracts", async (ctx) => {
    const results = getAllResults(ctx.chat.id);
    await ctx.reply(formatResultHistory(results, catalog), {
      parse_mode: "HTML",
    });
  });

  bot.command("results", async (ctx) => {
    const results = getAllResults(ctx.chat.id);
    await ctx.reply(formatResultHistory(results, catalog), {
      parse_mode: "HTML",
    });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `<b>How to use Safe Pay Agent</b>\n\nDescribe your action in natural language. I'll extract the intent, show you a confirmation, and execute it through Validance.\n\nAll actions requiring approval will show Approve/Deny buttons before executing.`,
      { parse_mode: "HTML" }
    );
  });

  // --- Message handler ---

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    // Skip commands (already handled above)
    if (text.startsWith("/")) return;

    // Keyword pre-filter: no signals → instant canned response
    if (!hasPaymentSignals(text)) {
      await ctx.reply(CANNED_RESPONSE, { parse_mode: "HTML" });
      return;
    }

    // Send processing placeholder
    const placeholder = await ctx.reply("Processing...");

    try {
      const activeResults = getActiveResults(chatId, catalog);
      const intent = await extractIntent(chatId, text, activeResults);

      if (intent.type === "text") {
        await bot.api.editMessageText(
          chatId,
          placeholder.message_id,
          intent.text
        );
        return;
      }

      // Action intent — submit to Validance
      const proposalId = crypto.randomUUID();
      const notifyUrl = `http://${webhookHost}:${webhookPort}/webhook?proposalId=${proposalId}`;

      const request: ProposalRequest = {
        action: intent.action,
        parameters: intent.params,
        session_hash: sessionHash(chatId),
        notify_url: notifyUrl,
      };

      await bot.api.editMessageText(
        chatId,
        placeholder.message_id,
        `${intent.summary}\n\nSubmitting to Validance...`
      );

      // Fire proposal in background (don't await — it blocks until approval + execution)
      const promise = validance.submitProposal(request);

      addPending(proposalId, {
        chatId,
        messageId: placeholder.message_id,
        promise,
        approvalId: null,
        action: intent.action,
        params: intent.params,
        createdAt: Date.now(),
      });

      // Handle promise resolution (runs after approval + execution)
      promise
        .then((result) =>
          handleProposalResult(bot, proposalId, result, catalog)
        )
        .catch((err) => handleProposalError(bot, proposalId, err));
    } catch (err) {
      console.error("[bot] Error processing message:", err);
      await bot.api.editMessageText(
        chatId,
        placeholder.message_id,
        formatError(err)
      );
    }
  });

  // --- Callback query handler (Approve/Deny buttons) ---

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [decision, proposalId] = data.split(":");
    if (!proposalId || (decision !== "approve" && decision !== "deny")) {
      await ctx.answerCallbackQuery({ text: "Invalid action" });
      return;
    }

    const entry = pendingProposals.get(proposalId);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Proposal expired or not found" });
      return;
    }

    if (!entry.approvalId) {
      await ctx.answerCallbackQuery({
        text: "Still waiting for approval ID. Try again in a moment.",
      });
      return;
    }

    try {
      const resolution = decision === "approve" ? "approved" : "denied";
      await validance.resolveApproval(entry.approvalId, {
        decision: resolution,
      });
      await ctx.answerCallbackQuery({
        text: decision === "approve" ? "Approved!" : "Denied",
      });

      if (decision === "deny") {
        await bot.api.editMessageText(
          entry.chatId,
          entry.messageId,
          "Action denied."
        );
        pendingProposals.delete(proposalId);
      } else {
        await bot.api.editMessageText(
          entry.chatId,
          entry.messageId,
          formatApprovalRequest(entry.action, entry.params, catalog) +
            "\n\n<i>Approved \u2014 executing...</i>",
          { parse_mode: "HTML" }
        );
      }
    } catch (err) {
      console.error("[bot] Error resolving approval:", err);
      await ctx.answerCallbackQuery({
        text: "Error resolving approval",
      });
    }
  });

  // --- Approval callback (invoked by webhook server) ---

  const onApprovalReady: OnApprovalReady = (proposalId, approvalId) => {
    const entry = pendingProposals.get(proposalId);
    if (!entry) {
      console.warn(
        `[bot] Approval for unknown proposal: ${proposalId}`
      );
      return;
    }

    entry.approvalId = approvalId;

    // Show approval buttons
    const keyboard = new InlineKeyboard()
      .text("Approve", `approve:${proposalId}`)
      .text("Deny", `deny:${proposalId}`);

    const text = formatApprovalRequest(entry.action, entry.params, catalog);

    bot.api
      .editMessageText(entry.chatId, entry.messageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      })
      .catch((err) => {
        console.error("[bot] Failed to show approval buttons:", err);
      });
  };

  return { bot, onApprovalReady };
}

// --- Result handlers (run after proposal completes) ---

async function handleProposalResult(
  bot: Bot,
  proposalId: string,
  result: ProposalResult,
  catalog: Catalog
): Promise<void> {
  const entry = pendingProposals.get(proposalId);
  if (!entry) return;

  try {
    const text = formatResult(result, entry.action, catalog);
    await bot.api.editMessageText(entry.chatId, entry.messageId, text, {
      parse_mode: "HTML",
    });

    // Generic result tracking + chat history
    if (result.status === "completed" && result.result?.output) {
      try {
        const output = JSON.parse(result.result.output);
        if (!output.error && output.status !== "failed") {
          addResult(entry.chatId, entry.action, output);
          recordToolResult(
            entry.chatId,
            entry.action,
            catalog.formatSummary(entry.action, output)
          );
        }
      } catch {
        // Non-JSON output, skip result tracking
      }
    } else if (result.status === "denied") {
      recordToolResult(entry.chatId, entry.action, "Action was denied by user.");
    } else if (result.status === "failed") {
      recordToolResult(entry.chatId, entry.action, `Failed: ${result.result?.error ?? result.reason ?? "unknown error"}`);
    }
  } catch (err) {
    console.error("[bot] Failed to update message with result:", err);
  } finally {
    pendingProposals.delete(proposalId);
  }
}

async function handleProposalError(
  bot: Bot,
  proposalId: string,
  error: unknown
): Promise<void> {
  const entry = pendingProposals.get(proposalId);
  if (!entry) return;

  try {
    await bot.api.editMessageText(
      entry.chatId,
      entry.messageId,
      formatError(error)
    );
  } catch (err) {
    console.error("[bot] Failed to update message with error:", err);
  } finally {
    pendingProposals.delete(proposalId);
  }
}
