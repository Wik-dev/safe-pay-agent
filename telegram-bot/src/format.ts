/**
 * Telegram message formatting. Pure functions, no I/O.
 */

import type { ContractRecord, ProposalResult } from "./store.js";

/** Format an approval request for inline display. */
export function formatApprovalRequest(
  action: string,
  params: Record<string, unknown>
): string {
  switch (action) {
    case "ton_escrow":
      return [
        `<b>Deploy Escrow Contract</b>`,
        ``,
        `<b>Recipient:</b> <code>${escapeHtml(String(params.recipient))}</code>`,
        `<b>Amount:</b> ${escapeHtml(String(params.amount))} TON`,
        `<b>Condition:</b> ${escapeHtml(String(params.condition))}`,
        ``,
        `Approve this payment?`,
      ].join("\n");

    case "ton_release":
      return [
        `<b>Release Escrow Funds</b>`,
        ``,
        `<b>Contract:</b> <code>${escapeHtml(String(params.contract_address))}</code>`,
        ``,
        `This will send all escrowed funds to the recipient.`,
      ].join("\n");

    case "ton_refund":
      return [
        `<b>Refund Escrow</b>`,
        ``,
        `<b>Contract:</b> <code>${escapeHtml(String(params.contract_address))}</code>`,
        ``,
        `This will refund all escrowed funds back to you.`,
      ].join("\n");

    default:
      return `<b>Action:</b> ${escapeHtml(action)}\n<b>Params:</b> ${escapeHtml(JSON.stringify(params))}`;
  }
}

/** Format a completed proposal result. */
export function formatResult(result: ProposalResult, action: string): string {
  if (result.status === "denied") {
    return "Payment denied.";
  }

  if (result.status === "rate_limited") {
    return `Rate limited: ${result.reason ?? "too many requests"}. Try again later.`;
  }

  if (result.status === "failed") {
    // error may be in result.error, result.reason, or inside the output JSON
    let error = result.result?.error ?? result.reason;
    if (!error && result.result?.output) {
      try {
        const parsed = JSON.parse(result.result.output);
        error = parsed.error;
      } catch { /* not JSON */ }
    }
    return `Execution failed: ${escapeHtml(error ?? result.result?.output ?? "Unknown error")}`;
  }

  // Parse worker JSON output
  try {
    const output = JSON.parse(result.result?.output ?? "{}");

    // Worker-level error (Validance returns "completed" but worker reported failure)
    if (output.error || output.status === "failed") {
      return `Execution failed: ${escapeHtml(output.error ?? "Worker reported failure")}`;
    }

    switch (action) {
      case "ton_escrow":
        return [
          `<b>Escrow Deployed</b>`,
          ``,
          `<b>Contract:</b> <code>${escapeHtml(output.contract_address)}</code>`,
          `<b>Recipient:</b> <code>${escapeHtml(output.recipient)}</code>`,
          `<b>Amount:</b> ${escapeHtml(output.amount)} TON`,
          `<b>Condition:</b> ${escapeHtml(output.condition)}`,
          `<b>Status:</b> ${output.status}`,
        ].join("\n");

      case "ton_release":
        return [
          `<b>Funds Released</b>`,
          ``,
          `<b>Contract:</b> <code>${escapeHtml(output.contract_address)}</code>`,
          `<b>Recipient:</b> <code>${escapeHtml(output.recipient)}</code>`,
          `<b>Status:</b> ${output.status}`,
        ].join("\n");

      case "ton_refund":
        return [
          `<b>Funds Refunded</b>`,
          ``,
          `<b>Contract:</b> <code>${escapeHtml(output.contract_address)}</code>`,
          `<b>Owner:</b> <code>${escapeHtml(output.owner)}</code>`,
          `<b>Status:</b> ${output.status}`,
        ].join("\n");

      default:
        return `<b>Result:</b>\n<pre>${escapeHtml(JSON.stringify(output, null, 2))}</pre>`;
    }
  } catch {
    return `<b>Result:</b>\n<pre>${escapeHtml(result.result?.output ?? "No output")}</pre>`;
  }
}

/** Format a list of contracts for /contracts command. */
export function formatContractList(contracts: ContractRecord[]): string {
  if (contracts.length === 0) {
    return "No contracts found. Send a payment request to create one!";
  }

  const lines = contracts.map((c, i) => {
    const status =
      c.status === "deployed"
        ? "Active"
        : c.status === "released"
          ? "Released"
          : "Refunded";
    return [
      `<b>${i + 1}.</b> ${escapeHtml(c.condition)}`,
      `   <code>${escapeHtml(c.address)}</code>`,
      `   ${escapeHtml(c.amount)} TON → <code>${escapeHtml(c.recipient.slice(0, 12))}...</code> [${status}]`,
    ].join("\n");
  });

  return `<b>Your Contracts:</b>\n\n${lines.join("\n\n")}`;
}

/** Format an error message for the user. */
export function formatError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return `Something went wrong: ${escapeHtml(msg)}`;
}

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
