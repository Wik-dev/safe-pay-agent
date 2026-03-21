/**
 * In-memory state for pending proposals and deployed contracts.
 * Adapted from safeclaw/src/pending-store.ts.
 */

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

export interface ContractRecord {
  address: string;
  recipient: string;
  amount: string;
  condition: string;
  status: "deployed" | "released" | "refunded";
  createdAt: number;
}

const MAX_PENDING = 50;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Global maps (survive module reloads in dev)
const PENDING_KEY = "__safepay_pending__";
const CONTRACTS_KEY = "__safepay_contracts__";

function getGlobal<T>(key: string, factory: () => T): T {
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) g[key] = factory();
  return g[key] as T;
}

export const pendingProposals = getGlobal<Map<string, PendingEntry>>(
  PENDING_KEY,
  () => new Map()
);

export const contractsByChat = getGlobal<Map<number, ContractRecord[]>>(
  CONTRACTS_KEY,
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

/** Add a contract record for a chat (deduplicates by address). */
export function addContract(chatId: number, record: ContractRecord): void {
  const list = contractsByChat.get(chatId) ?? [];
  const existing = list.findIndex((c) => c.address === record.address);
  if (existing >= 0) {
    list[existing] = record; // replace with latest
  } else {
    list.push(record);
  }
  contractsByChat.set(chatId, list);
}

/** Update contract status by address. */
export function updateContractStatus(
  chatId: number,
  address: string,
  status: "released" | "refunded"
): void {
  const list = contractsByChat.get(chatId);
  if (!list) return;
  for (const contract of list) {
    if (contract.address === address) contract.status = status;
  }
}

/** Get active (deployed) contracts for a chat. */
export function getActiveContracts(chatId: number): ContractRecord[] {
  return (contractsByChat.get(chatId) ?? []).filter(
    (c) => c.status === "deployed"
  );
}

/** Get all contracts for a chat. */
export function getAllContracts(chatId: number): ContractRecord[] {
  return contractsByChat.get(chatId) ?? [];
}
