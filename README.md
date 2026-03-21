# Safe Pay Agent

**AI payment agent on Telegram that validates every transaction through a safety engine before executing on TON.**

## Problem

AI agents are getting access to money. They make mistakes — wrong amount, wrong recipient, no recourse. There's no safety layer between AI intent and on-chain execution.

## Solution

User chats naturally in Telegram. AI proposes the payment. [Validance](https://validance.io) validates, requires human approval, then executes an escrow contract on TON. The AI can propose but cannot execute without approval.

## Architecture

```
Telegram User
    ↓ "Send 0.5 TON to EQ... for coffee"
Grammy Bot + Claude AI
    ↓ extracts intent → structured proposal
Validance Engine
    ├─ Catalog match (only allowed actions)
    ├─ Rate limit (3 deployments/hr)
    ├─ Human approval gate ← [Approve] [Deny]
    └─ Secret isolation (mnemonic never exposed to AI)
    ↓ approved → spawn isolated container
TON Blockchain
    └─ SafePayment escrow contract (deploy / release / refund)
```

## Full Escrow Lifecycle

> "Send 0.05 TON to EQ... for hackathon demo"

| Step | Screenshot |
|------|-----------|
| 1. AI parses intent, asks approval | ![](docs/1-approve.png) |
| 2. Contract deployed on TON | ![](docs/2-deployed.png) |
| 3. User releases funds | ![](docs/3-release.png) |
| 4. Funds sent to recipient | ![](docs/4-released.png) |

*"Release the hackathon demo escrow" — the AI remembers the contract from context and routes the release to the correct address. That's the intelligence layer, not just a form.*

Contract on testnet: [`EQDnAviCiYQKc72vNg4JA9Z4xX5wOieF0PB2oDtWfEYflep_`](https://testnet.tonscan.org/address/EQDnAviCiYQKc72vNg4JA9Z4xX5wOieF0PB2oDtWfEYflep_)

## How to Run

```bash
git clone https://github.com/Wik-dev/safe-pay-agent && cd safe-pay-agent
npm install && npx blueprint build SafePayment
docker compose --profile build build ton-worker && docker compose up -d validance postgres
cd telegram-bot && npm install && cp .env.example .env
# Set TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, and VALIDANCE_URL (default: http://localhost:7500)
npx tsx --env-file=.env src/index.ts
```

## E2E Tests (no Telegram needed)

```bash
cd telegram-bot && npx tsx --env-file=.env tests/test_e2e.ts
# 24 tests: keyword filter, Claude extraction, deploy+approve, deny flow
```

## Tech Stack

Tact + Blueprint (smart contract) · Grammy (Telegram bot) · Claude Sonnet (intent extraction) · Validance (validated execution engine) · TON testnet

## What's Next

The safety engine is generic — same approval gates, rate limits, and audit trails scale to any complexity. Recurring payments, multi-step workflows, spending limits, multi-sig approval chains. Same engine, same safety, any complexity.

## License

MIT
