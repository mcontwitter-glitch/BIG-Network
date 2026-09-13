# BIG Network

**BIG Network** is the **official blockchain of Bigfoot404 LLC** — the company's own chain, its native token **$BIG**, and the network infrastructure for Bigfoot404's corporate treasury, digital assets, and business operations.

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

All genesis supply sits in the **treasury wallet** — the company vault — which funds the faucet and future distribution under Bigfoot404 LLC's direction.

## Repository Layout

| File | Purpose |
|---|---|
| `bootstrap.js` | One-shot network bootstrap: treasury wallet, $BIG mint, genesis supply. Idempotent — safe to re-run; it detects existing state and skips. |
| `gateway.js` | HTTP gateway (port 9090) exposing chain actions (stats, transfers) as JSON endpoints. |
| `faucet.js` | $BIG faucet — drips test tokens to requester wallets. |
| `wallet.js` | BIG Wallet Service — chain-backed custodial wallets (create / balance / send $BIG). Keys live only on the ledger volume. |
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

### BIG Wallet Service (chain-backed)

| Endpoint | Method | What it does |
|---|---|---|
| `/wallet/create` | POST `{}` | Creates a custodial BIG wallet — keypair stored on the ledger volume (`/workspace/bigchain/wallets`, mode 600), ATA created on chain, 1 SOL airdropped for fees. Returns the address. |
| `/wallet/balance?address=<pubkey>` | GET | SOL + $BIG balance for any chain address; `custodial: true` if it's a network-held wallet. |
| `/wallet/send` | POST `{from, to, amount}` | Sends $BIG from a custodial network wallet to any address (ATA auto-created). Signed on-pod, returns the chain sig. |
| `/wallet/list` | GET | Public keys of all custodial network wallets (addresses only — secrets never leave the volume). |

Wallets are BIG network assets: the chain holds the balances, the pod holds the keys, the treasury funds the faucet — nothing custodial lives off the pod.
```

See `docs/OPS-RUNBOOK.md` for the full operational guide, restart ritual, and troubleshooting.

## Security

- **Keypairs and secrets are never committed.** `.gitignore` blocks `*.key`, `keys.env`, and the validator/vote/faucet keypairs. Only public addresses live in `chain.json`.
- The ledger database (`ledger/`) is runtime state — excluded from the repo.

## What BIG Network Is

**BIG Network is Bigfoot404 LLC's corporate blockchain.** $BIG is the company's native token — held, governed, and distributed by Bigfoot404 LLC as a business asset, not tied to any single product or game.

Any product integration (games, apps, platforms) would be a separate corporate decision using $BIG as a medium — the network itself stands on its own as company infrastructure.

## Ownership

**BIG Network and $BIG are property of Bigfoot404 LLC.** All development, automations, and IP associated with the network and its tooling are owned by Bigfoot404 LLC.

This repository (under MC's GitHub account) is the **official and only home** of BIG Network. It is not part of, hosted in, or affiliated with any other account, organization, or game repository.

## Agent Operations Grid

The network dashboard lives at [agent-network.html](https://mcontwitter-glitch.github.io/BIG-Network/agent-network.html) — real agent roster, live event log, task console, and real pipeline numbers (no fake TPS).

## Run a node — help the network

Every node makes the BIG Network faster: wallet + BIGscan reads get served by the nearest healthy node instead of one box. One command on any fresh Ubuntu 20.04+/Debian 11+ box (or cloud pod):

```bash
curl -fsSL https://raw.githubusercontent.com/mcontwitter-glitch/BIG-Network/main/install-node.sh | sudo bash
```

That installs the Agave validator, fetches the chain bundle (genesis + latest snapshot), generates a fresh node identity, and starts an **RPC replica** under systemd (`big-node`).

To follow the live chain from the seed node in real time:

```bash
curl -fsSL https://raw.githubusercontent.com/mcontwitter-glitch/BIG-Network/main/install-node.sh | sudo bash -s -- --entrypoint <seed-host>:8001
```

Flags: `--mode rpc|validator` (validator needs a staking pass — contact the network team), `--dir`, `--rpc-port`.

After install: check `journalctl -u big-node -f`, then **send your node's public hostname + RPC port to the network team** so wallet + BIGscan traffic routes to it.

Security: this repo contains **no private keys** — node operators generate their own identity on install. Never share any keypair file with anyone, including us.
