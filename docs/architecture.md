# Safe Pay Agent — Architecture & Technical Reference

## System Overview

Safe Pay Agent is a Telegram bot where users describe payments in natural language. Claude AI extracts structured intent, Validance validates and gates execution behind human approval, and isolated worker containers deploy escrow contracts on TON testnet.

```
Telegram User
    ↓ long polling
Grammy Bot (bot.ts)
    ↓ keyword pre-filter
Claude AI (ai.ts) ─── tool_use ──→ structured intent
    ↓
Validance Client (validance.ts)
    ↓ POST /api/proposals (blocks until approval + execution)
    ↓
Webhook Server (webhook.ts) ←── Validance POSTs approval_id
    ↓
Bot edits message → [Approve] [Deny] inline buttons
    ↓ user taps
Bot → POST /api/approvals/{id}/resolve
    ↓
Proposal unblocks → worker container executes → result
    ↓
Bot shows contract address
```

---

## Smart Contract

**File:** `contracts/safe_payment.tact`

Minimal escrow with owner-only release/refund and self-destruct.

### State

| Field | Type | Description |
|-------|------|-------------|
| `owner` | `Address` | Contract deployer (payer) |
| `recipient` | `Address` | Payment recipient |
| `condition` | `String` | Human-readable release condition |
| `released` | `Bool` | Double-spend guard |

### Messages

| Message | Opcode | Who | Effect |
|---------|--------|-----|--------|
| _(empty)_ | — | Anyone | Deposit TON |
| `"deposit"` | — | Anyone | Deposit TON |
| `Release` | `0x1856D189` | Owner only | Send all funds to recipient, self-destruct |
| `Refund` | `0x83FB1615` | Owner only | Return all funds to owner, self-destruct |

### Getters

| Getter | Returns |
|--------|---------|
| `balance()` | `Int` — current contract balance |
| `isReleased()` | `Bool` — whether funds have been released |
| `details()` | `PaymentDetails { recipient, condition, released, balance }` |

### Security

- `self.requireOwner()` on Release and Refund
- `require(!self.released, "Already released")` prevents double-spend
- `SendRemainingBalance | SendDestroyIfZero` atomically empties and destroys the contract

---

## Validance Catalog

**File:** `catalog/ton-payments.json`

Three templates, all requiring human approval. Secrets injected into worker containers by Validance — never exposed to the AI or bot.

| Template | Command | Params | Rate Limit | Timeout |
|----------|---------|--------|------------|---------|
| `ton_escrow` | `node /app/dist/ton_escrow.js` | `recipient`, `amount`, `condition` | 3/hr | 120s |
| `ton_release` | `node /app/dist/ton_release.js` | `contract_address` | 5/hr | 120s |
| `ton_refund` | `node /app/dist/ton_refund.js` | `contract_address` | 5/hr | 120s |

**Common attributes:**

| Attribute | Value |
|-----------|-------|
| `approval_tier` | `human-confirm` |
| `persistent` | `false` (one-shot containers) |
| `docker_image` | `ton-worker` → `safe-pay-ton-worker:latest` |
| `secret_refs` | `TON_MNEMONIC`, `TON_API_ENDPOINT`, `TON_API_KEY` |
| `network_policy` | Egress whitelist: `testnet.toncenter.com`, `toncenter.com` |

---

## Worker Container

**Image:** `safe-pay-ton-worker:latest` (multi-stage Node 22 Alpine)

Workers read `VALIDANCE_PARAMS` (JSON env var) and write JSON to stdout.

### ton_escrow.ts

**Input:** `{ recipient: string, amount: string, condition: string }`

**Output:** `{ contract_address, recipient, amount, condition, status: "deployed" }`

Flow: parse params → create TonClient → derive wallet from mnemonic → create SafePayment contract instance → send deploy+deposit tx → poll until active (30 × 2s) → output address.

### ton_release.ts

**Input:** `{ contract_address: string }`

**Output:** `{ contract_address, action: "release", recipient, status: "released" }`

Flow: load contract → verify not released → build Release message (opcode `0x1856D189`) → send with 0.05 TON fee → poll until destroyed (20 × 2s).

### ton_refund.ts

**Input:** `{ contract_address: string }`

**Output:** `{ contract_address, action: "refund", owner, status: "refunded" }`

Flow: load contract → verify not released → build Refund message (opcode `0x83FB1615`) → send with 0.05 TON fee → poll until destroyed (20 × 2s).

### Helper Libraries

| File | Function | Env Vars |
|------|----------|----------|
| `lib/client.ts` | `createClient()` → `TonClient` | `TON_API_ENDPOINT` (required), `TON_API_KEY` (optional) |
| `lib/wallet.ts` | `getWallet()` → `{ wallet: WalletContractV4, keyPair }` | `TON_MNEMONIC` (required, 24 words) |

---

## Telegram Bot

**Location:** `telegram-bot/src/`

### Module Map

| File | Role | Dependencies |
|------|------|--------------|
| `index.ts` | Entry point — load env, health check, start bot + webhook | bot, validance, webhook |
| `bot.ts` | Grammy bot — commands, message handler, callback queries | ai, validance, store, format, webhook |
| `ai.ts` | Claude tool_use intent extraction with keyword pre-filter | `@anthropic-ai/sdk`, store |
| `validance.ts` | HTTP client for Validance REST API | none (native fetch) |
| `webhook.ts` | Node http server for approval notifications | none (node:http) |
| `store.ts` | In-memory pending proposals + contract tracking | none |
| `format.ts` | Telegram HTML message formatting | store (types only) |

### Keyword Pre-Filter (ai.ts)

Before calling Claude, a regex checks for payment signals:

```
/\d+(\.\d+)?\s*(ton|TON)|(?:EQ|UQ)[A-Za-z0-9_-]{46,48}|send|pay|transfer|escrow|release|refund|deploy|contract|deny/i
```

No match → instant canned response. No API call, no latency, no cost.

### Claude Intent Extraction (ai.ts)

**Model:** `claude-sonnet-4-6` | **Max tokens:** 1024

Three tools registered:

| Tool | Maps to | Required Params |
|------|---------|----------------|
| `create_escrow` | `ton_escrow` | `recipient`, `amount`, `condition` |
| `release_escrow` | `ton_release` | `contract_address` |
| `refund_escrow` | `ton_refund` | `contract_address` |

**System prompt** includes the list of active contracts (address, amount, recipient, condition) so Claude can resolve "release the coffee escrow" to the correct address.

**Return types:**

```typescript
type IntentResult =
  | { type: "tool_call"; action: string; params: Record<string, unknown>; summary: string }
  | { type: "text"; text: string };
```

### Bot Commands (bot.ts)

| Command | Response |
|---------|----------|
| `/start` | Welcome + capabilities |
| `/contracts` | List all contracts (active + historical) |
| `/help` | Usage examples |

### Message Flow (bot.ts)

```
message:text received
  ↓
Skip if starts with "/"
  ↓
hasPaymentSignals()? NO → canned response (instant)
  ↓ YES
Send "Processing..." placeholder
  ↓
extractIntent(text, activeContracts)
  ↓
text response? → edit placeholder with Claude's reply
  ↓
tool_call? →
  1. Generate proposalId (UUID)
  2. Build notify_url: http://{WEBHOOK_HOST}:{WEBHOOK_PORT}/webhook?proposalId={id}
  3. Fire submitProposal() in background (don't await)
  4. Store { chatId, messageId, promise, approvalId: null, action, params }
  5. promise.then() → handleProposalResult()
  6. promise.catch() → handleProposalError()
```

### Approval Flow

```
Validance POSTs to notify_url
  ↓
webhook.ts parses { approval_id } from body
  ↓
onApprovalReady(proposalId, approvalId)
  ↓
bot.ts sets entry.approvalId, edits message with:
  [Approve] [Deny] inline keyboard
  ↓
User taps button → callback_query:data = "approve:{proposalId}" or "deny:{proposalId}"
  ↓
resolveApproval(approvalId, { decision: "approved" | "denied" })
  ↓
submitProposal() promise resolves → handleProposalResult() edits message
```

### Session Hash

```typescript
SHA256("tg:" + chatId)  // per-chat, used for Validance rate limits + audit
```

### In-Memory State (store.ts)

**`pendingProposals`** `Map<proposalId, PendingEntry>`:

```typescript
interface PendingEntry {
  chatId: number;
  messageId: number;
  promise: Promise<ProposalResult>;  // blocks until execution
  approvalId: string | null;         // set by webhook
  action: string;
  params: Record<string, unknown>;
  createdAt: number;
}
```

- Max 50 entries, GC at 10 minutes, oldest-eviction at capacity.

**`contractsByChat`** `Map<chatId, ContractRecord[]>`:

```typescript
interface ContractRecord {
  address: string;
  recipient: string;
  amount: string;
  condition: string;
  status: "deployed" | "released" | "refunded";
  createdAt: number;
}
```

- Deduplicated by address on insert.
- Active contracts (status="deployed") passed to Claude's system prompt.

### Validance Client (validance.ts)

| Method | Endpoint | Timeout |
|--------|----------|---------|
| `submitProposal(req)` | `POST /api/proposals` | 5 min |
| `resolveApproval(id, resolution)` | `POST /api/approvals/{id}/resolve` | default |
| `healthCheck()` | `GET /api/health` | 5s |

```typescript
interface ProposalRequest {
  action: string;
  parameters: Record<string, unknown>;
  session_hash: string;
  notify_url?: string;
}

interface ProposalResult {
  status: "completed" | "failed" | "denied" | "rate_limited";
  result?: { output: string; output_vars: Record<string, unknown>; exit_code?: number; error?: string };
  reason?: string;
  duration_seconds?: number;
}
```

### Webhook Server (webhook.ts)

Node built-in `http` module. No Express.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Returns `{ status: "ok" }` |
| `/webhook?proposalId={id}` | POST | Receives `{ approval_id, type, template_name, proposal }`, calls `onApprovalReady()` |

---

## Docker Compose

**File:** `docker-compose.yml`

| Service | Image | Ports | Notes |
|---------|-------|-------|-------|
| `postgres` | `postgres:16-alpine` | 5434:5432 | Validance DB, health-checked |
| `validance` | `validance-engine:latest` | 7500:8000 | Catalog + Docker socket mounted |
| `telegram-bot` | Built from `./telegram-bot` | 3000:3000 | `WEBHOOK_HOST=telegram-bot` (compose DNS) |
| `ton-worker` | `safe-pay-ton-worker:latest` | — | Build-only (`--profile build`), not auto-started |

**Volumes:** `pgdata` (Postgres data), `workdir` (shared work directory for proposals).

Inside compose, `VALIDANCE_URL=http://validance:8000` and `WEBHOOK_HOST=telegram-bot` — Docker internal DNS handles routing.

---

## Environment Variables

| Variable | Required | Default | Used By |
|----------|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot |
| `ANTHROPIC_API_KEY` | Yes | — | Bot (Claude SDK) |
| `VALIDANCE_URL` | No | `http://localhost:8001` | Bot |
| `WEBHOOK_PORT` | No | `3000` | Bot |
| `WEBHOOK_HOST` | No | `172.18.0.1` | Bot |
| `TON_MNEMONIC` | Yes | — | Validance → Worker |
| `TON_API_ENDPOINT` | No | `https://testnet.toncenter.com/api/v2/jsonRPC` | Validance → Worker |
| `TON_API_KEY` | No | — | Validance → Worker |
| `POSTGRES_PASSWORD` | No | `validance_dev` | Compose |

---

## Security Model

### Secret Isolation

Secrets (`TON_MNEMONIC`, `TON_API_ENDPOINT`, `TON_API_KEY`) are defined in docker-compose environment, stored by Validance, and injected only into worker containers at execution time. The AI (Claude) and the bot process never see them.

### Approval Gate

Every proposal requires `human-confirm`. The flow is:
1. Validance creates a pending approval
2. Webhook notifies the bot with `approval_id`
3. Bot shows [Approve] / [Deny] buttons
4. User explicitly decides
5. Only after approval does the worker container execute

### Rate Limiting

Per-session (SHA256 of chat ID), per-template limits enforced by Validance:
- `ton_escrow`: 3/hour
- `ton_release`: 5/hour
- `ton_refund`: 5/hour

### Network Isolation

Worker containers have `egress_whitelist` restricting outbound to TON API endpoints only. No arbitrary network access.

### Contract Security

- Owner-only release/refund (`requireOwner()`)
- Double-spend prevention (`released` flag)
- Atomic self-destruct after action (`SendRemainingBalance | SendDestroyIfZero`)

---

## Tests

### Smart Contract (5 tests)

**File:** `tests/SafePayment.spec.ts` | **Runner:** Jest + `@ton/sandbox`

| Test | Assertion |
|------|-----------|
| Deploy + verify state | owner, recipient, condition, released=false |
| Release to recipient | Funds to recipient, contract destroyed |
| Refund to owner | Funds to owner, contract destroyed |
| Reject non-owner release | Exit code 132, contract unchanged |
| Self-destruct after release | Balance zero, contract destroyed |

### E2E Integration (24 tests)

**File:** `telegram-bot/tests/test_e2e.ts` | **Runner:** `npx tsx --env-file=.env`

Exercises the full flow without Telegram — direct function calls + HTTP to Validance.

| Suite | Tests | What it covers |
|-------|-------|---------------|
| Keyword pre-filter | 8 | Regex matching for payment signals |
| Validance health | 1 | API reachability |
| Intent extraction | 6 | Claude tool_use: escrow, release (with address resolution), conversational |
| Full proposal flow | 5 | Submit → webhook → approve → on-chain deploy → contract address |
| Deny flow | 1 | Submit → webhook → deny → status "denied" |

The test spins up its own webhook server on port 3100 (separate from bot's 3000) to capture `approval_id` from Validance, then resolves it programmatically.

Three tests call the real Claude API (`claude-sonnet-4-6`) — not mocked.

---

## File Tree

```
safe-pay-agent/
├── contracts/
│   └── safe_payment.tact              # Tact escrow contract
├── tests/
│   └── SafePayment.spec.ts            # 5 sandbox tests
├── wrappers/
│   └── SafePayment.ts                 # Blueprint wrapper
├── scripts/
│   └── deploySafePayment.ts           # Manual testnet deployment
├── catalog/
│   └── ton-payments.json              # Validance catalog (3 templates)
├── worker/
│   ├── Dockerfile                     # Multi-stage Node 22 Alpine
│   ├── package.json                   # @ton/core, @ton/crypto, @ton/ton
│   ├── tsconfig.json
│   └── scripts/
│       ├── lib/
│       │   ├── client.ts              # TonClient factory
│       │   ├── wallet.ts              # Mnemonic → WalletV4
│       │   └── tact_SafePayment.ts    # Generated contract wrapper
│       ├── ton_escrow.ts              # Deploy + deposit
│       ├── ton_release.ts             # Release funds to recipient
│       └── ton_refund.ts              # Refund funds to owner
├── telegram-bot/
│   ├── Dockerfile                     # Multi-stage Node 22 Alpine
│   ├── package.json                   # grammy, @anthropic-ai/sdk
│   ├── tsconfig.json
│   ├── .env.example
│   ├── src/
│   │   ├── index.ts                   # Entry: env check, start bot + webhook
│   │   ├── bot.ts                     # Grammy: commands, handlers, callbacks
│   │   ├── ai.ts                      # Claude tool_use + keyword pre-filter
│   │   ├── validance.ts               # Validance HTTP client
│   │   ├── webhook.ts                 # Approval webhook server (node:http)
│   │   ├── store.ts                   # In-memory proposals + contracts
│   │   └── format.ts                  # Telegram HTML formatting
│   └── tests/
│       └── test_e2e.ts                # 24 E2E tests (no Telegram needed)
├── docs/
│   ├── architecture.md                # This file
│   ├── 1-approve.png                  # Demo screenshot: approval request
│   ├── 2-deployed.png                 # Demo screenshot: contract deployed
│   ├── 3-release.png                  # Demo screenshot: release approval
│   └── 4-released.png                 # Demo screenshot: funds released
├── docker-compose.yml                 # postgres + validance + telegram-bot + ton-worker
├── .env.example
├── package.json                       # Root: Blueprint + Jest + TON SDK
├── tsconfig.json
└── README.md
```
