/**
 * Telegram message formatting. Pure functions, no I/O.
 * All rendering is driven by catalog display config.
 */

import type { Catalog } from "./catalog.js";
import { humanize } from "./catalog.js";
import type { ProposalResult, ResultRecord } from "./store.js";

/** Format an approval request for inline display. */
export function formatApprovalRequest(
  action: string,
  params: Record<string, unknown>,
  catalog: Catalog
): string {
  const display = catalog.template(action)?.display;
  const title = display?.title ?? humanize(action);

  const lines = [`<b>${escapeHtml(title)}</b>`, ""];
  for (const [key, val] of Object.entries(params)) {
    const label = display?.param_labels?.[key] ?? humanize(key);
    const value = String(val);
    // Use <code> for address-like values, plain text otherwise
    const formatted = looksLikeAddress(value)
      ? `<code>${escapeHtml(value)}</code>`
      : escapeHtml(value);
    lines.push(`<b>${escapeHtml(label)}:</b> ${formatted}`);
  }
  lines.push("", "Approve this action?");

  return lines.join("\n");
}

/** Format a completed proposal result. */
export function formatResult(
  result: ProposalResult,
  action: string,
  catalog: Catalog
): string {
  if (result.status === "denied") {
    return "Action denied.";
  }

  if (result.status === "rate_limited") {
    return `Rate limited: ${result.reason ?? "too many requests"}. Try again later.`;
  }

  if (result.status === "failed") {
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

    // Worker-level error
    if (output.error || output.status === "failed") {
      return `Execution failed: ${escapeHtml(output.error ?? "Worker reported failure")}`;
    }

    const display = catalog.template(action)?.display;
    const title = display?.result_title ?? humanize(action);
    const labels = display?.result_labels ?? {};

    const lines = [`<b>${escapeHtml(title)}</b>`, ""];
    for (const [key, val] of Object.entries(output)) {
      if (val === undefined || val === null) continue;
      const label = labels[key] ?? humanize(key);
      const value = String(val);
      const formatted = looksLikeAddress(value)
        ? `<code>${escapeHtml(value)}</code>`
        : escapeHtml(value);
      lines.push(`<b>${escapeHtml(label)}:</b> ${formatted}`);
    }

    return lines.join("\n");
  } catch {
    return `<b>Result:</b>\n<pre>${escapeHtml(result.result?.output ?? "No output")}</pre>`;
  }
}

/** Format result history for /contracts (or any listing) command. */
export function formatResultHistory(
  results: ResultRecord[],
  catalog: Catalog
): string {
  if (results.length === 0) {
    return "No results found. Try requesting an action!";
  }

  const lines = results.map((r, i) => {
    const display = catalog.template(r.action)?.display;
    const title = display?.title ?? humanize(r.action);
    const statusField = display?.context_status_field;
    const status = statusField ? String(r.output[statusField] ?? "unknown") : "done";

    const detailParts: string[] = [];
    const contextFields = display?.context_fields ?? Object.keys(r.output).slice(0, 3);
    for (const field of contextFields) {
      if (r.output[field] !== undefined) {
        const value = String(r.output[field]);
        const short = value.length > 16 ? value.slice(0, 12) + "..." : value;
        detailParts.push(looksLikeAddress(value) ? `<code>${escapeHtml(short)}</code>` : escapeHtml(short));
      }
    }

    return [
      `<b>${i + 1}.</b> ${escapeHtml(title)}`,
      `   ${detailParts.join(" | ")} [${escapeHtml(capitalize(status))}]`,
    ].join("\n");
  });

  return `<b>Your Results:</b>\n\n${lines.join("\n\n")}`;
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

/** Convert Markdown formatting to Telegram HTML. */
export function markdownToTelegramHtml(text: string): string {
  // Escape HTML entities first
  let out = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Bold: **text** → <b>text</b>
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic: *text* → <i>text</i> (but not inside bold)
  out = out.replace(/(?<!\w)\*(?!\*)(.+?)(?<!\*)\*(?!\w)/g, "<i>$1</i>");
  // Inline code: `text` → <code>text</code>
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Strikethrough: ~~text~~ → <s>text</s>
  out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");
  // Remove --- horizontal rules (not supported in Telegram)
  out = out.replace(/^-{3,}$/gm, "");
  return out;
}

/** Check if a value looks like a blockchain address. */
function looksLikeAddress(value: string): boolean {
  return /^(EQ|UQ|0:)[A-Za-z0-9_-]{20,}$/.test(value);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
