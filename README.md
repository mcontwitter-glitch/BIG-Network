# BIG Network

**BIG Network** is the home of **$BIG** — the token economy powering Bigfoot404's game universe (Bigfoot Bros), built on a Solana-based local devnet prototype.

> **Status:** Local devnet prototype. The chain runs on a self-hosted Solana validator. Going public (hosted validator + public RPC endpoint) is a future decision — this repo documents the network as it stands.

---

## The $BIG Token

| Property | Value |
|---|---|
| **Symbol** | BIG |
| **Name** | BIG Chain |
| **Total Supply** | 404,000,000 BIG (genesis mint — fixed) |
| **Decimals** | 9 |
| **Standard** | SPL Token (classic program — max wallet compatibility) |
| **Network** | Solana devnet (local validator, RPC `127.0.0.1:8899`) |

All genesis supply sits in the **treasury wallet**, which funds the faucet and future distribution.

## Repository Layout

| File | Purpose |
|---|---|
| `bootstrap.js` | One-shot network bootstrap: treasury wallet, $BIG mint, genesis supply. Idempotent — safe to re-run; it detects existing state and skips. |
| `gateway.js` | HTTP gateway (port 9090) exposing chain actions (stats, transfers) as JSON endpoints. |
| `faucet.js` | $BIG faucet — drips test tokens to requester wallets. |
| `fundloop.sh` | Watchdog loop that waits for the chain and runs bootstrap until `chain.json` appears. |
| `big-chain-console.html` | Self-contained web console for the network (stats, faucet, transfers). |
| `chain.example.json` | Example of the runtime manifest produced by `bootstrap.js` (RPC URL, treasury, mint, supply). |
| `keys.example.env` | Template for `keys.env` (public keys only — never commit real keypairs). |
| `docs/` | Ops runbook and architecture notes. |

## Quick Start

```bash
npm install                          # @solana/web3.js + spl-token
# 1. Start the local validator (agave 2.1.21)
solana-test-validator --ledger ledger --bind-address 127.0.0.1 --rpc-port 8899
# 2. Bootstrap the network (creates/reuses treasury + mint, writes chain.json)
node bootstrap.js
# 3. Start the gateway
node gateway.js                      # listens on 9090
```

See `docs/OPS-RUNBOOK.md` for the full operational guide, restart ritual, and troubleshooting.

## Security

- **Keypairs and secrets are never committed.** `.gitignore` blocks `*.key`, `keys.env`, and the validator/vote/faucet keypairs. Only public addresses live in `chain.json`.
- The ledger database (`ledger/`) is runtime state — excluded from the repo.

## Relationship to the Games

- **Bigfoot Bros** — the $BIG token IS the in-world coin economy: gold coins stamped BIG, Mario-style collectible arcs, tied into the BIG Network.
- **AVALON: The Waking Gates** — deliberately crypto-free. No tokens, no wallets, no crypto anywhere in Avalon.

## Ownership

**BIG Network and $BIG are property of Bigfoot404 LLC.** All development, automations, and IP associated with the network and its tooling are owned by Bigfoot404 LLC.

This repository (under MC's GitHub account) is the **official and only home** of BIG Network. It is not part of, hosted in, or affiliated with any other account, organization, or game repository.
