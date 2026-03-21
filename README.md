# Safe AI Payment Agent

AI-proposed payments validated by [Validance](https://validance.io), executed on TON blockchain.

**BSA-EPFL Stablecoins & Payments Hackathon — AlphaTON Capital Track**

## Architecture

```
┌─────────────────────────┐
│  AI Agent (Layer 1+)    │
│  "Pay 0.5 TON to EQ..." │
└────────┬────────────────┘
         │ POST /api/proposals
┌────────▼────────────────┐
│  Validance Engine       │
│  ├─ Catalog match       │
│  ├─ Rate limit (3/hr)   │
│  ├─ Human approval gate │
│  └─ Secret injection    │
└────────┬────────────────┘
         │ approved → spawn container
┌────────▼────────────────┐
│  TON Worker Container   │
│  ├─ Derive wallet       │
│  ├─ Deploy escrow       │
│  └─ Return result       │
└────────┬────────────────┘
         │ on-chain tx
┌────────▼────────────────┐
│  TON Blockchain         │
│  SafePayment contract   │
│  (escrow → release/     │
│   refund)               │
└─────────────────────────┘
```

## Why Validance?

Without Validance, an AI agent with wallet access can drain funds instantly. Validance adds:

- **Human approval** — every payment requires explicit confirmation
- **Rate limiting** — max 3 escrow deployments per hour
- **Secret isolation** — wallet mnemonic never exposed to the AI
- **Audit trail** — every proposal logged with decision + outcome
- **Catalog enforcement** — AI can only call pre-defined actions

## Quick Start

```bash
# 1. Install & build contract
npm install
npx blueprint build SafePayment

# 2. Run contract tests
npx jest

# 3. Copy wrapper for worker
npm run copy-wrapper

# 4. Configure secrets
cp .env.example .env.secrets
# Edit .env.secrets with your testnet mnemonic

# 5. Build worker image & start
docker compose --profile build build ton-worker
docker compose up -d validance postgres
```

## Demo Flow (curl)

```bash
# Health check
curl -s http://localhost:7500/api/health

# Submit escrow proposal (blocks on approval)
curl -X POST http://localhost:7500/api/proposals \
  -H "Content-Type: application/json" \
  -d '{
    "action": "ton_escrow",
    "parameters": {
      "recipient": "EQD...",
      "amount": "0.1",
      "condition": "hackathon demo"
    },
    "session_hash": "demo001"
  }' &

# Check pending approvals
curl -s http://localhost:7500/api/approvals/pending

# Approve (replace {id} with actual approval ID)
curl -X POST http://localhost:7500/api/approvals/{id}/resolve \
  -H "Content-Type: application/json" \
  -d '{"decision": "approved"}'

# Result: {"status":"completed","result":{"output":"{\"contract_address\":\"EQ...\"}"}}
```

## Smart Contract

`contracts/safe_payment.tact` — minimal escrow:

| Message | Who | Effect |
|---------|-----|--------|
| _(empty)_ | Anyone | Deploy + deposit TON |
| `"deposit"` | Anyone | Add more TON |
| `Release` | Owner only | Send all funds to recipient, self-destruct |
| `Refund` | Owner only | Send all funds back to owner, self-destruct |

## Validance Catalog

3 templates in `catalog/ton-payments.json`:

| Template | Approval | Rate Limit | Description |
|----------|----------|------------|-------------|
| `ton_escrow` | human-confirm | 3/hour | Deploy contract + deposit |
| `ton_release` | human-confirm | 5/hour | Release funds to recipient |
| `ton_refund` | human-confirm | 5/hour | Refund funds to owner |

## Project Structure

```
safe-pay-agent/
├── contracts/safe_payment.tact    # Tact escrow contract
├── tests/SafePayment.spec.ts      # Sandbox tests (5 cases)
├── wrappers/SafePayment.ts        # Blueprint wrapper
├── scripts/deploySafePayment.ts   # Testnet deployment
├── worker/                        # Validance container image
│   ├── Dockerfile
│   ├── scripts/
│   │   ├── lib/client.ts          # TonClient factory
│   │   ├── lib/wallet.ts          # Wallet-from-mnemonic
│   │   ├── ton_escrow.ts          # Deploy + deposit
│   │   ├── ton_release.ts         # Release to recipient
│   │   └── ton_refund.ts          # Refund to owner
│   └── package.json
├── catalog/ton-payments.json      # Validance catalog
├── docker-compose.yml             # Engine + DB + worker
└── README.md
```

## Layered Strategy

| Layer | Component | Status |
|-------|-----------|--------|
| 0 | TON contract + Validance integration | **This repo** |
| 1 | Telegram bot + AI agent | Next |
| 2 | SafeClaw plugin integration | Future |
| 3 | OpenClaw full assistant | Future |

Each layer is additive — Layer 0 is fully functional standalone via curl/API.

## License

MIT
