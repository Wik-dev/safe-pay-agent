# Test Log — 2026-03-22

Manual E2E test against TON testnet with live Telegram bot (@SafeClowBot).

## Environment

- Validance engine: `http://localhost:8001` (dev container, 10 workers)
- Catalog: `catalog/ton-payments.json` (4 actions)
- TON network: testnet
- Wallet: `kQBmYCM3cdFAc3Ofk4MaH5KdWiDbKJkyRZhwnCmC5tWbKO9u`

## Results

| # | Feature | Prompt / Command | Result |
|---|---------|-----------------|--------|
| 1 | Single escrow deploy | "Send 0.05 TON to EQ... for testing" | Deployed: `EQByp-_lD4I6D7-7QTL900lsBIMrY0Y69NBNjmnmcDAgj_N6` |
| 2 | Balance check | "what is my balance?" | Auto-approved, showed 1.603 TON |
| 3 | Release escrow | "release the testing escrow" | Released via context (AI remembered contract) |
| 4 | Conversational | "hello, what can you do?" | Text response, no approval buttons |
| 5 | Multi-payment (3x) | "Make 3 separate payments... 0.01 coffee, 0.02 lunch, 0.03 dinner" | 3 sequential approvals, all 3 deployed |
| 6 | Approve + Remember | "Send 0.01 TON... condition: testing learned policies" | Deployed + policy rule created |
| 7 | /policies | `/policies` | Showed 1 learned rule: `ton_escrow: allow` |
| 8 | /reset_policies | `/reset_policies` | Cleared 1 rule |
| 9 | /status | `/status` | Engine healthy, 4 actions loaded |
| 10 | /catalog | `/catalog` | All 4 actions with tiers, rates, descriptions |
| 11 | /help | `/help` | Full command list including /reset_policies |

## Issues Found & Fixed During Testing

- **Deadlock on multi-tool**: 3 parallel proposals exhausted all 3 uvicorn workers, blocking approval resolution. Fix: increased workers to 10.
- **Seqno race**: 3 simultaneous TON deploys from same wallet caused 500 errors. Fix: sequential execution in multi-tool path.
- **Grammy middleware blocking**: `await submitProposalAsync` in message handler blocked callback processing. Fix: fire-and-forget async chain.
- **resolveApproval blocking**: Validance resolve endpoint blocks until worker completes. Fix: fire-and-forget in callback handler.
- **Bot crash on stale callbacks**: No `bot.catch` handler. Fix: added error handler in index.ts.
- **TON_MNEMONIC missing from ton_balance**: `secret_refs` didn't include mnemonic needed for wallet derivation. Fix: added to catalog.
