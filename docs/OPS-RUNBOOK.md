# BIG Network — Ops Runbook

Operating guide for the BIG Network local devnet. Audience: whoever runs the sandbox/machine hosting the validator (currently the BIGagent404 sandbox).

## Current Runtime Facts

- **Validator binary:** agave 2.1.21 (`solana-test-validator` at `/root/.local/share/solana/install/releases/2.1.21/solana-release/bin/`)
- **Ledger:** `ledger/` in the working directory (genesis + full account state survives restarts)
- **RPC:** `http://127.0.0.1:8899`
- **Gateway:** `http://127.0.0.1:9090`
- **Runtime manifest:** `chain.json` (written by `bootstrap.js` once treasury + mint + supply verified)

## Restart Ritual (after sandbox/machine reboot)

```bash
cd <big-chain working dir>
# kill any lingering validator procs first
solana-test-validator --ledger ledger --bind-address 127.0.0.1 --rpc-port 8899
node bootstrap.js     # idempotent — regenerates chain.json, skips if state exists
node gateway.js       # if the gateway needs restarting
```

**The `--bind-address 127.0.0.1` flag is REQUIRED in the sandbox.** Without it the discovery service tries to bind on an unresolvable host and dies with `Discover failed` after ~a minute of uptime.

## Known Issues / Gotchas

1. **`agave-validator` (full node binary) does NOT work in the sandbox** — it fails the OS network limit test (`net.core.rmem_max` too small, `netdev_max_backlog` sysctl missing) and exits. Always use `solana-test-validator`.
2. **`Discover failed`** = discovery socket bind failure. Fix: `--bind-address 127.0.0.1` (see ritual above).
3. **`fundloop.sh` retry spam / `fetch failed`** = validator not up yet. It loops bootstrap every 2 minutes until `chain.json` exists — safe to leave running, or kill it once the chain is hand-restored.
4. **Ledger lock:** if a validator died uncleanly, `ledger/ledger.lock` may need removing before restart.

## Health Checks

```bash
# slot height (should climb every check)
curl -s -X POST http://127.0.0.1:8899 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'

# treasury SOL balance
curl -s -X POST http://127.0.0.1:8899 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["<TREASURY>"]}'
```

`bootstrap.js` prints the full state on run: treasury pubkey, SOL balance, mint pubkey, and total $BIG supply.

## Secrets Policy

- `treasury.key`, `mint.key`, `keys.env`, and the validator/vote/faucet keypairs live ONLY on the host machine, never in the repo or in chat.
- `keys.example.env` documents the format (public keys only).
- If the host is compromised or keys leak: the mint keypair controls supply — treat it as the most sensitive file in the project.

## Going Public (future decision — NOT current state)

$BIG is currently a local prototype. A public BIG Network would require:
1. A hosted, always-on validator (or a small cluster) with a public RPC endpoint
2. A decision on network policy (who validates, is supply still fixed at 404M)
3. Wallet onboarding docs for players
4. Legal/compliance review under Bigfoot404 LLC before anything public

None of the above has been approved yet. This repo stays documentation + tooling until then.
