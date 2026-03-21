/**
 * HTTP client for Validance REST API.
 * Adapted from safeclaw/src/kernel-client.ts. Zero dependencies.
 */

import type { ProposalResult } from "./store.js";

export interface ProposalRequest {
  action: string;
  parameters: Record<string, unknown>;
  session_hash: string;
  notify_url?: string;
}

export class ValidanceClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Submit a proposal (blocks until execution completes or is denied). */
  async submitProposal(req: ProposalRequest): Promise<ProposalResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 min

    try {
      const res = await fetch(`${this.baseUrl}/api/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (res.status === 429) {
        return { status: "rate_limited", reason: "Rate limit exceeded" };
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Validance API error ${res.status}: ${text}`);
      }

      return (await res.json()) as ProposalResult;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Resolve a pending approval (approve or deny). */
  async resolveApproval(
    approvalId: string,
    resolution: { decision: "approved" | "denied" }
  ): Promise<{ status: string }> {
    const res = await fetch(
      `${this.baseUrl}/api/approvals/${approvalId}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resolution),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Approval resolve error ${res.status}: ${text}`);
    }

    return (await res.json()) as { status: string };
  }

  /** Check Validance API health. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
