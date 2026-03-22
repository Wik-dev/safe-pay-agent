/**
 * In-memory state for pending proposals and completed results.
 * Adapted from safeclaw/src/pending-store.ts.
 */

import type { Catalog } from "./catalog.js";

export interface PendingEntry {
  chatId: number;
  messageId: number;
  promise: Promise<ProposalResult>;
  approvalId: string | null;
  action: string;
  params: Record<string, unknown>;
  createdAt: number;
}

export interface ProposalResult {
  status: "completed" | "failed" | "denied" | "rate_limited";
  result?: {
    output: string;
    output_vars: Record<string, unknown>;
    exit_code?: number;
    error?: string;
  };
  reason?: string;
  duration_seconds?: number;
}

export interface ResultRecord {
  action: string;
  output: Record<string, unknown>;
  createdAt: number;
}

const MAX_PENDING = 50;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Global maps (survive module reloads in dev)
const PENDING_KEY = "__safepay_pending__";
const RESULTS_KEY = "__safepay_results__";

function getGlobal<T>(key: string, factory: () => T): T {
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) g[key] = factory();
  return g[key] as T;
}

export const pendingProposals = getGlobal<Map<string, PendingEntry>>(
  PENDING_KEY,
  () => new Map()
);

export const resultsByChat = getGlobal<Map<number, ResultRecord[]>>(
  RESULTS_KEY,
  () => new Map()
);

/** Remove entries older than MAX_AGE_MS. */
export function gcPending(): void {
  const now = Date.now();
  for (const [id, entry] of pendingProposals) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      pendingProposals.delete(id);
    }
  }
}

/** Add a pending entry with GC + oldest-eviction if at capacity. */
export function addPending(id: string, entry: PendingEntry): void {
  gcPending();
  if (pendingProposals.size >= MAX_PENDING) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, e] of pendingProposals) {
      if (e.createdAt < oldestTime) {
        oldestTime = e.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) pendingProposals.delete(oldestKey);
  }
  pendingProposals.set(id, entry);
}

/** Add a result record for a chat (deduplicates by action + identifying output fields). */
export function addResult(
  chatId: number,
  action: string,
  output: Record<string, unknown>
): void {
  const list = resultsByChat.get(chatId) ?? [];

  // Deduplicate: if the output has a unique identifier field (like contract_address),
  // update existing record with same identifier
  const idField = findIdField(output);
  if (idField) {
    const existing = list.findIndex(
      (r) => r.action === action && r.output[idField] === output[idField]
    );
    if (existing >= 0) {
      list[existing] = { action, output, createdAt: Date.now() };
      resultsByChat.set(chatId, list);
      return;
    }
  }

  list.push({ action, output, createdAt: Date.now() });
  resultsByChat.set(chatId, list);
}

/** Update a result's output fields by matching an identifier. */
export function updateResult(
  chatId: number,
  identifierField: string,
  identifierValue: unknown,
  updates: Record<string, unknown>
): void {
  const list = resultsByChat.get(chatId);
  if (!list) return;
  for (const record of list) {
    if (record.output[identifierField] === identifierValue) {
      Object.assign(record.output, updates);
    }
  }
}

/** Get active results for a chat, filtered by catalog display config. */
export function getActiveResults(
  chatId: number,
  catalog: Catalog
): ResultRecord[] {
  const all = resultsByChat.get(chatId) ?? [];
  return all.filter((r) => {
    const display = catalog.template(r.action)?.display;
    if (!display?.context_status_field || !display?.context_active_value) {
      return true; // no filter config → always active
    }
    return r.output[display.context_status_field] === display.context_active_value;
  });
}

/** Get all results for a chat. */
export function getAllResults(chatId: number): ResultRecord[] {
  return resultsByChat.get(chatId) ?? [];
}

/** Find a likely unique identifier field in output. */
function findIdField(output: Record<string, unknown>): string | null {
  // Common identifier fields
  for (const field of ["contract_address", "address", "id", "tx_hash"]) {
    if (output[field] !== undefined) return field;
  }
  return null;
}
