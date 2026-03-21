/**
 * End-to-end test: exercises AI extraction → Validance proposal → approval → result
 * without Telegram in the loop.
 *
 * Usage: npx tsx --env-file=.env tests/test_e2e.ts
 */

import { createServer, type Server } from "node:http";
import { hasPaymentSignals, extractIntent } from "../src/ai.js";
import { ValidanceClient, type ProposalRequest } from "../src/validance.js";
import type { ProposalResult } from "../src/store.js";

const VALIDANCE_URL = process.env.VALIDANCE_URL ?? "http://localhost:8001";
const WEBHOOK_PORT = 3100; // dedicated test port (bot uses 3000)
const WEBHOOK_HOST = process.env.WEBHOOK_HOST ?? "172.18.0.1";
const TEST_ADDRESS = "EQCPsCWbBzbu9yGX0EBMqyabpG7nZwx2C9HWZwMe6Llun7YE";

const client = new ValidanceClient(VALIDANCE_URL);

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// --- Webhook helper: captures approval_id from Validance notification ---

function startWebhookCapture(
  port: number
): { server: Server; waitForApproval: (proposalId: string) => Promise<string> } {
  const pending = new Map<string, (approvalId: string) => void>();

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/webhook")) {
      const url = new URL(req.url, `http://localhost:${port}`);
      const proposalId = url.searchParams.get("proposalId");
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        try {
          const event = JSON.parse(body);
          if (proposalId && event.approval_id) {
            const resolve = pending.get(proposalId);
            if (resolve) {
              resolve(event.approval_id);
              pending.delete(proposalId);
            }
          }
        } catch { /* ignore */ }
        res.writeHead(200);
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port);

  function waitForApproval(proposalId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Approval webhook timeout for ${proposalId}`)),
        30_000
      );
      pending.set(proposalId, (approvalId) => {
        clearTimeout(timeout);
        resolve(approvalId);
      });
    });
  }

  return { server, waitForApproval };
}

// ============================================================
// Test suites
// ============================================================

async function testKeywordPreFilter(): Promise<void> {
  console.log("\n--- Keyword Pre-Filter ---");

  assert(!hasPaymentSignals("hello"), "hello → no signals");
  assert(!hasPaymentSignals("what time is it?"), "what time → no signals");
  assert(!hasPaymentSignals("tell me a joke"), "joke → no signals");

  assert(hasPaymentSignals("send 0.5 TON"), "send 0.5 TON → has signals");
  assert(
    hasPaymentSignals("pay EQCPsCWbBzbu9yGX0EBMqyabpG7nZwx2C9HWZwMe6Llun7YE"),
    "pay + EQ address → has signals"
  );
  assert(hasPaymentSignals("release the escrow"), "release → has signals");
  assert(hasPaymentSignals("refund my payment"), "refund → has signals");
  assert(
    hasPaymentSignals("deploy a contract for 1 TON"),
    "deploy + number → has signals"
  );
}

async function testIntentExtraction(): Promise<void> {
  console.log("\n--- Intent Extraction (Claude) ---");

  // Escrow intent
  const escrow = await extractIntent(
    `Send 0.05 TON to ${TEST_ADDRESS} for hackathon demo`,
    []
  );
  assert(escrow.type === "tool_call", "escrow message → tool_call");
  if (escrow.type === "tool_call") {
    assert(escrow.action === "ton_escrow", `action = ton_escrow (got ${escrow.action})`);
    assert(escrow.params.recipient === TEST_ADDRESS, "recipient matches");
    assert(escrow.params.amount === "0.05", `amount = 0.05 (got ${escrow.params.amount})`);
    assert(typeof escrow.params.condition === "string", "condition is string");
  }

  // Release intent with active contract context
  const fakeContract = {
    address: "EQFakeAddress123",
    recipient: TEST_ADDRESS,
    amount: "0.05",
    condition: "Coffee delivered",
    status: "deployed" as const,
    createdAt: Date.now(),
  };
  const release = await extractIntent("Release the coffee escrow", [fakeContract]);
  assert(release.type === "tool_call", "release message → tool_call");
  if (release.type === "tool_call") {
    assert(release.action === "ton_release", `action = ton_release (got ${release.action})`);
    assert(
      release.params.contract_address === "EQFakeAddress123",
      `resolved address (got ${release.params.contract_address})`
    );
  }

  // Conversational (no tool call)
  const chat = await extractIntent("What can you do?", []);
  assert(chat.type === "text", "conversational message → text response");
}

async function testValidanceHealth(): Promise<void> {
  console.log("\n--- Validance Health ---");

  const healthy = await client.healthCheck();
  assert(healthy, `Validance healthy at ${VALIDANCE_URL}`);
}

async function testFullProposalFlow(): Promise<void> {
  console.log("\n--- Full Proposal Flow (deploy + approve) ---");

  const { server, waitForApproval } = startWebhookCapture(WEBHOOK_PORT);

  try {
    const proposalId = crypto.randomUUID();
    const notifyUrl = `http://${WEBHOOK_HOST}:${WEBHOOK_PORT}/webhook?proposalId=${proposalId}`;

    const request: ProposalRequest = {
      action: "ton_escrow",
      parameters: {
        recipient: TEST_ADDRESS,
        amount: "0.05",
        condition: "E2E test",
      },
      session_hash: "e2e_test_session",
      notify_url: notifyUrl,
    };

    // Fire proposal in background (blocks until approval + execution)
    const proposalPromise = client.submitProposal(request);

    // Wait for webhook to deliver approval_id
    console.log("  ...waiting for approval webhook");
    const approvalId = await waitForApproval(proposalId);
    assert(typeof approvalId === "string" && approvalId.length > 0, `got approval_id: ${approvalId}`);

    // Approve
    const resolveResult = await client.resolveApproval(approvalId, { decision: "approved" });
    assert(resolveResult.status === "approved", `approval approved (got ${resolveResult.status})`);

    // Wait for proposal to complete
    console.log("  ...waiting for on-chain execution");
    const result: ProposalResult = await proposalPromise;
    assert(result.status === "completed", `proposal completed (got ${result.status})`);

    if (result.result?.output) {
      const output = JSON.parse(result.result.output);
      if (output.error) {
        console.log(`  INFO  Worker error: ${output.error}`);
      } else {
        assert(typeof output.contract_address === "string", `contract deployed: ${output.contract_address}`);
        assert(output.status === "deployed", `status = deployed`);
      }
    }
  } finally {
    server.close();
  }
}

async function testDenyFlow(): Promise<void> {
  console.log("\n--- Deny Flow ---");

  const { server, waitForApproval } = startWebhookCapture(WEBHOOK_PORT);

  try {
    const proposalId = crypto.randomUUID();
    const notifyUrl = `http://${WEBHOOK_HOST}:${WEBHOOK_PORT}/webhook?proposalId=${proposalId}`;

    const request: ProposalRequest = {
      action: "ton_escrow",
      parameters: {
        recipient: TEST_ADDRESS,
        amount: "0.01",
        condition: "Deny test",
      },
      session_hash: "e2e_test_session",
      notify_url: notifyUrl,
    };

    const proposalPromise = client.submitProposal(request);

    console.log("  ...waiting for approval webhook");
    const approvalId = await waitForApproval(proposalId);

    // Deny
    await client.resolveApproval(approvalId, { decision: "denied" });

    const result: ProposalResult = await proposalPromise;
    assert(result.status === "denied", `proposal denied (got ${result.status})`);
  } finally {
    server.close();
  }
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log("Safe Pay Agent — E2E Tests");
  console.log(`Validance: ${VALIDANCE_URL}`);
  console.log(`Webhook: ${WEBHOOK_HOST}:${WEBHOOK_PORT}`);

  await testKeywordPreFilter();
  await testValidanceHealth();
  await testIntentExtraction();
  await testFullProposalFlow();
  await testDenyFlow();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
