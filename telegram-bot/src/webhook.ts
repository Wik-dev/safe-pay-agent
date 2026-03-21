/**
 * HTTP server for Validance approval webhook notifications.
 * Uses Node built-in http module (no Express).
 */

import { createServer, type Server } from "node:http";

export interface WebhookEvent {
  type: string;
  approval_id: string;
  template_name: string;
  proposal: Record<string, unknown>;
}

export type OnApprovalReady = (
  proposalId: string,
  approvalId: string
) => void;

export function createWebhookServer(
  onApprovalReady: OnApprovalReady
): Server {
  const server = createServer((req, res) => {
    // Health check
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Webhook endpoint
    if (req.method === "POST" && req.url?.startsWith("/webhook")) {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const proposalId = url.searchParams.get("proposalId");

      if (!proposalId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing proposalId query param" }));
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          const event = JSON.parse(body) as WebhookEvent;
          if (event.approval_id) {
            onApprovalReady(proposalId, event.approval_id);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true }));
        } catch (err) {
          console.error("[webhook] Failed to parse body:", err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end("Not found");
  });

  return server;
}
