/**
 * Grammy bot — message handlers, approval buttons, callback queries.
 */

import { Bot, InlineKeyboard } from "grammy";
import crypto from "node:crypto";
import type { Catalog } from "./catalog.js";
import { extractIntent, hasPaymentSignals, recordToolResult, type PaymentIntent } from "./ai.js";
import { ValidanceClient, type ProposalRequest } from "./validance.js";
import {
  addResult,
  addPending,
  getActiveResults,
  getAllResults,
  getChatHistory,
  pendingProposals,
  updateResult,
  type ProposalResult,
} from "./store.js";
import {
  formatApprovalRequest,
  formatResultHistory,
  formatError,
  formatResult,
  markdownToTelegramHtml,
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
      `<b>Safe Pay Agent</b>\n\nI help you execute validated actions via natural language.\n\nJust describe what you want to do, and I'll handle the rest.\n\n<b>Commands:</b>\n/help \u2014 Full command list\n/results \u2014 List your results\n/policies \u2014 Learned rules\n/reset_policies \u2014 Clear learned rules`,
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
      `<b>How to use Safe Pay Agent</b>\n\nDescribe your action in natural language. I'll extract the intent, show you a confirmation, and execute it through Validance.\n\nAll actions requiring approval will show Approve/Deny buttons before executing. Use <b>Approve + Remember</b> to teach the engine to auto-approve similar actions in the future.\n\n<b>Commands:</b>\n/status \u2014 Engine health + catalog summary\n/audit \u2014 Your audit trail\n/contracts \u2014 Active contracts\n/policies \u2014 Learned policy rules\n/reset_policies \u2014 Clear all learned rules\n/catalog \u2014 Available actions + safety config\n/results \u2014 Result history`,
      { parse_mode: "HTML" }
    );
  });

  // --- Validance introspection commands ---

  bot.command("status", async (ctx) => {
    try {
      const health = await validance.getHealth();
      const dbStatus = health.database === "healthy" ? "connected" : health.database;
      const actionCount = catalog.actions.length;

      const actionLines = catalog.actions.map((name) => {
        const tpl = catalog.template(name)!;
        const tier = tpl.approval_tier;
        const rate = tpl.rate_limit ? `${tpl.rate_limit}/hr` : "unlimited";
        return `  <code>${escapeCmd(name)}</code>  \u2014 ${escapeCmd(tier)} (${rate})`;
      });

      await ctx.reply(
        `\ud83d\udfe2 <b>Validance Engine:</b> ${escapeCmd(health.status)}\n<b>Database:</b> ${escapeCmd(dbStatus)}\n<b>Catalog:</b> ${actionCount} actions loaded\n\n<b>Actions:</b>\n${actionLines.join("\n")}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("\u26a0\ufe0f Validance engine not reachable");
    }
  });

  bot.command("audit", async (ctx) => {
    try {
      const session = sessionHash(ctx.chat.id);
      const entityId = `proposal_${session.slice(0, 8)}`;
      const audit = await validance.getAuditTrail(entityId);

      if (audit.total_events === 0) {
        await ctx.reply(
          `\ud83d\udccb <b>Audit Trail</b> (session: <code>${session.slice(0, 8)}...</code>)\n\nNo audit events found.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Filter to last 24h and limit display
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = audit.events.filter(
        (e) => e.timestamp && new Date(e.timestamp).getTime() > cutoff
      );

      if (recent.length === 0) {
        await ctx.reply(
          `\ud83d\udccb <b>Audit Trail</b> (session: <code>${session.slice(0, 8)}...</code>)\n\n${audit.total_events} events total, but none in the last 24h.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const lines = recent.slice(-15).map((e, i) => {
        const time = e.timestamp
          ? new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : "??:??";
        let detail = "";
        if (e.details) {
          const d = e.details;
          if (d.template_name) detail += `\n   ${escapeCmd(String(d.template_name))}`;
          if (d.decision) detail += `\n   decided_by: ${escapeCmd(String(d.decided_by ?? "user"))}`;
        }
        if (e.event_hash) {
          const prev = e.previous_entity_hash?.slice(0, 4) ?? "0000";
          detail += `\n   hash: <code>${prev}\u2192${e.event_hash.slice(0, 4)}</code>`;
        }
        return `${i + 1}. [${time}] <b>${escapeCmd(e.event_type)}</b>${detail}`;
      });

      await ctx.reply(
        `\ud83d\udccb <b>Audit Trail</b> (session: <code>${session.slice(0, 8)}...</code>)\n\n${lines.join("\n\n")}\n\nNo events older than 24h shown.`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("\u26a0\ufe0f Validance engine not reachable");
    }
  });

  bot.command("policies", async (ctx) => {
    try {
      const session = sessionHash(ctx.chat.id);
      const policies = await validance.getPolicies(session);

      if (policies.rules.length === 0) {
        await ctx.reply(
          `\ud83d\udee1\ufe0f <b>Learned Policies</b>\n\nNo learned rules yet.\nApprove an action with "remember" to create rules.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const lines = policies.rules.map((r, i) => {
        const pattern = Object.keys(r.match_pattern).length > 0
          ? `\n   Pattern: ${escapeCmd(JSON.stringify(r.match_pattern))}`
          : "";
        let expiry = "";
        if (r.expires_at) {
          const days = Math.ceil(
            (new Date(r.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          );
          expiry = ` (expires in ${days}d)`;
        }
        const source = r.approval_id ? `\n   Created from: approval #${escapeCmd(r.approval_id)}` : "";
        return `${i + 1}. <b>${escapeCmd(r.template_name)}:</b> ${escapeCmd(r.scope)}${expiry}${pattern}${source}`;
      });

      await ctx.reply(
        `\ud83d\udee1\ufe0f <b>Learned Policies</b>\n\n${lines.join("\n\n")}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("\u26a0\ufe0f Validance engine not reachable");
    }
  });

  bot.command("reset_policies", async (ctx) => {
    try {
      const session = sessionHash(ctx.chat.id);
      const policies = await validance.getPolicies(session);

      if (policies.rules.length === 0) {
        await ctx.reply("No learned policies to reset.");
        return;
      }

      let deleted = 0;
      for (const rule of policies.rules) {
        await validance.deletePolicy(rule.rule_id);
        deleted++;
      }

      await ctx.reply(
        `\ud83d\udee1\ufe0f Cleared ${deleted} learned policy rule${deleted > 1 ? "s" : ""}.`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("\u26a0\ufe0f Validance engine not reachable");
    }
  });

  bot.command("catalog", async (ctx) => {
    const lines = catalog.actions.map((name) => {
      const tpl = catalog.template(name)!;
      const tier = tpl.approval_tier;
      const rate = tpl.rate_limit ? `${tpl.rate_limit}/hr` : "unlimited";
      const secrets = (tpl as Record<string, unknown>).secret_refs;
      const secretCount = Array.isArray(secrets) ? secrets.length : 0;
      const secretInfo = secretCount > 0 ? ` | Secrets: ${secretCount}` : "";
      return `<b>${escapeCmd(name)}</b>\n  Tier: ${escapeCmd(tier)} | Rate: ${rate}${secretInfo}\n  ${escapeCmd(tpl.description)}`;
    });

    await ctx.reply(
      `\ud83d\udcd6 <b>Action Catalog</b>\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML" }
    );
  });

  // --- Message handler ---

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;

    // Skip commands (already handled above)
    if (text.startsWith("/")) return;

    // Keyword pre-filter: no signals, no history, not a question → canned response
    const hasHistory = getChatHistory(chatId).length > 0;
    if (!hasPaymentSignals(text) && !hasHistory && !text.includes("?")) {
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
          markdownToTelegramHtml(intent.text),
          { parse_mode: "HTML" }
        );
        return;
      }

      if (intent.type === "multi_tool_call") {
        // Multiple actions — execute sequentially to avoid blockchain seqno races.
        // Run in background so the message handler returns and Grammy can process callbacks.
        await bot.api.editMessageText(
          chatId,
          placeholder.message_id,
          `${intent.intents.length} actions queued — processing sequentially...`
        );

        const session = sessionHash(chatId);
        const intents = intent.intents;
        // Fire-and-forget the sequential chain
        (async () => {
          for (const sub of intents) {
            const msg = await bot.api.sendMessage(
              chatId,
              formatApprovalRequest(sub.action, sub.params, catalog) + "\n\n<i>Submitting to Validance...</i>",
              { parse_mode: "HTML" }
            );
            await submitProposalAsync(chatId, msg.message_id, sub, session);
          }
        })().catch((err) => console.error("[bot] Multi-tool chain error:", err));
        return;
      }

      // Single action intent — submit to Validance
      await bot.api.editMessageText(
        chatId,
        placeholder.message_id,
        `${intent.summary}\n\nSubmitting to Validance...`
      );
      submitProposal(chatId, placeholder.message_id, intent, sessionHash(chatId));
    } catch (err) {
      console.error("[bot] Error processing message:", err);
      await bot.api.editMessageText(
        chatId,
        placeholder.message_id,
        formatError(err)
      );
    }
  });

  // --- Callback query handler (Approve/Deny/Remember buttons) ---

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    console.log(`[cb] Callback received: ${data}`);
    const [decision, proposalId] = data.split(":");
    if (!proposalId || !["approve", "deny", "remember"].includes(decision)) {
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
      const isApproval = decision === "approve" || decision === "remember";
      const resolution: { decision: "approved" | "denied"; remember?: boolean } = {
        decision: isApproval ? "approved" : "denied",
      };
      if (decision === "remember") resolution.remember = true;

      // Fire-and-forget: resolveApproval blocks until worker finishes,
      // so we must not await it or it blocks all other callback processing.
      validance.resolveApproval(entry.approvalId, resolution).catch((err) => {
        console.error("[bot] Error resolving approval:", err);
      });

      const labels: Record<string, string> = {
        approve: "Approved!",
        remember: "Approved + rule created!",
        deny: "Denied",
      };
      await ctx.answerCallbackQuery({ text: labels[decision] });

      if (decision === "deny") {
        await bot.api.editMessageText(
          entry.chatId,
          entry.messageId,
          "Action denied."
        );
        pendingProposals.delete(proposalId);
      } else {
        const suffix = decision === "remember"
          ? "\n\n<i>Approved + remembered \u2014 executing...</i>"
          : "\n\n<i>Approved \u2014 executing...</i>";
        await bot.api.editMessageText(
          entry.chatId,
          entry.messageId,
          formatApprovalRequest(entry.action, entry.params, catalog) + suffix,
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
    console.log(`[webhook] Approval ready: proposal=${proposalId}, approval=${approvalId}`);
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
      .text("\u2705 Approve", `approve:${proposalId}`)
      .text("\ud83d\uddd1 Deny", `deny:${proposalId}`)
      .row()
      .text("\ud83e\udde0 Approve + Remember", `remember:${proposalId}`);

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

  // --- Proposal submission helper ---

  function submitProposal(
    chatId: number,
    messageId: number,
    intent: PaymentIntent,
    session: string
  ): void {
    const proposalId = crypto.randomUUID();
    const notifyUrl = `http://${webhookHost}:${webhookPort}/webhook?proposalId=${proposalId}`;

    const request: ProposalRequest = {
      action: intent.action,
      parameters: intent.params,
      session_hash: session,
      notify_url: notifyUrl,
    };

    const promise = validance.submitProposal(request);

    addPending(proposalId, {
      chatId,
      messageId,
      promise,
      approvalId: null,
      action: intent.action,
      params: intent.params,
      createdAt: Date.now(),
    });

    promise
      .then((result) =>
        handleProposalResult(bot, proposalId, result, catalog)
      )
      .catch((err) => handleProposalError(bot, proposalId, err));
  }

  /** Like submitProposal but returns a promise that resolves when the proposal completes. */
  async function submitProposalAsync(
    chatId: number,
    messageId: number,
    intent: PaymentIntent,
    session: string
  ): Promise<void> {
    const proposalId = crypto.randomUUID();
    const notifyUrl = `http://${webhookHost}:${webhookPort}/webhook?proposalId=${proposalId}`;

    const request: ProposalRequest = {
      action: intent.action,
      parameters: intent.params,
      session_hash: session,
      notify_url: notifyUrl,
    };

    const promise = validance.submitProposal(request);

    addPending(proposalId, {
      chatId,
      messageId,
      promise,
      approvalId: null,
      action: intent.action,
      params: intent.params,
      createdAt: Date.now(),
    });

    try {
      const result = await promise;
      await handleProposalResult(bot, proposalId, result, catalog);
    } catch (err) {
      await handleProposalError(bot, proposalId, err);
    }
  }

  return { bot, onApprovalReady };
}

/** Escape HTML for Telegram. */
function escapeCmd(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
