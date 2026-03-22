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

  /** Resolve a pending approval (approve or deny, optionally remember). */
  async resolveApproval(
    approvalId: string,
    resolution: { decision: "approved" | "denied"; remember?: boolean }
  ): Promise<{ status: string; learned_rule_id?: string }> {
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

  /** Check Validance API health (returns full status). */
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

  /** Get detailed health status. */
  async getHealth(): Promise<HealthResponse> {
    const res = await fetch(`${this.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return (await res.json()) as HealthResponse;
  }

  /** Get audit trail for an entity. */
  async getAuditTrail(entityId: string, limit?: number): Promise<AuditResponse> {
    const url = new URL(`${this.baseUrl}/api/audit/${entityId}`);
    if (limit) url.searchParams.set("limit", String(limit));
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Audit query failed: ${res.status}`);
    return (await res.json()) as AuditResponse;
  }

  /** Get learned policy rules. */
  async getPolicies(sessionHash?: string): Promise<PoliciesResponse> {
    const url = new URL(`${this.baseUrl}/api/policies`);
    if (sessionHash) url.searchParams.set("session_hash", sessionHash);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Policies query failed: ${res.status}`);
    return (await res.json()) as PoliciesResponse;
  }
  /** Delete a learned policy rule. */
  async deletePolicy(ruleId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/policies/${ruleId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Delete policy failed: ${res.status}`);
  }
}

export interface HealthResponse {
  status: string;
  database: string;
  azure_storage?: string;
  timestamp: string;
}

export interface AuditEvent {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  timestamp: string | null;
  details: Record<string, unknown> | null;
  event_hash: string;
  previous_event_hash: string;
  previous_entity_hash: string;
}

export interface AuditResponse {
  entity_id: string;
  total_events: number;
  events: AuditEvent[];
}

export interface PolicyRule {
  rule_id: string;
  template_name: string;
  scope: string;
  match_pattern: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
  approval_id: string | null;
  session_hash: string | null;
  reason: string | null;
}

export interface PoliciesResponse {
  rules: PolicyRule[];
}
