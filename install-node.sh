#!/usr/bin/env bash
# ============================================================================
#  BIG Chain — Node Installer
#  Spins up a BIG Chain RPC node on any fresh Ubuntu 20.04+/Debian 11+ box
#  (or any cloud pod) in ~3 minutes.
#
#  One command (RPC replica — helps network speed by serving reads):
#    curl -fsSL https://raw.githubusercontent.com/mcontwitter-glitch/BIG-Network/main/install-node.sh | sudo bash
#
#  Join the live seed (follows new blocks in real time):
#    curl -fsSL .../install-node.sh | sudo bash -s -- --entrypoint seed-host:8001
#
#  Modes:
#    rpc        (default) — replica node, serves RPC reads, no vote. This is
#               the "help with network speed" mode: wallet + BIGscan queries
#               hit the nearest healthy node instead of one box.
#    validator  — full voting validator. Requires a vote account registered +
#               BIG stake delegated to it. Contact the network team
#               (info@bigfoot404.biz) to get the staking pass.
#
#  Flags:
#    --entrypoint HOST:PORT   seed node gossip address to sync from (optional —
#                             without it the node starts from the bundled
#                             snapshot and serves reads at that slot)
#    --mode rpc|validator     default rpc
#    --dir /opt/big-chain     install location
#    --rpc-port 8899          local RPC port
# ============================================================================
set -euo pipefail

MODE="rpc"
ENTRYPOINT=""
DIR="/opt/big-chain"
RPC_PORT="8899"
while [ $# -gt 0 ]; do
  case "$1" in
    --entrypoint) ENTRYPOINT="${2:-}"; shift 2 ;;
    --entrypoint=*) ENTRYPOINT="${1#*=}"; shift ;;
    --mode) MODE="${2:-rpc}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --rpc-port) RPC_PORT="${2:-8899}"; shift 2 ;;
    --rpc-port=*) RPC_PORT="${1#*=}"; shift ;;
    *) shift ;;
  esac
done

REPO_RAW="https://raw.githubusercontent.com/mcontwitter-glitch/BIG-Network/main"
GOSSIP_PORT="8001"

log() { echo -e "\033[1;33m[BIG]\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || { log "run as root (sudo)"; exit 1; }
log "BIG Chain node installer — mode: ${MODE}"

# ---------------------------------------------------------------- 1. deps
log "installing prerequisites..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || true
apt-get install -y -qq curl jq tar bzip2 zstd >/dev/null 2>&1 || apt-get install -y curl jq tar bzip2 zstd

# ---------------------------------------------------------------- 2. agave
if ! command -v agave-validator >/dev/null 2>&1; then
  log "installing Agave validator..."
  curl -sSfL https://release.anza.xyz/stable/install | sh
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
  grep -q "solana/install/active_release/bin" "$HOME/.bashrc" 2>/dev/null || \
    echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"
fi
AGAVE_BIN="$(command -v agave-validator)"
log "agave-validator: $($AGAVE_BIN --version 2>/dev/null | head -1)"

# ---------------------------------------------------------------- 3. bundle
log "fetching BIG Chain bundle (genesis + snapshot + chain.json)..."
mkdir -p "$DIR/ledger/snapshot" "$DIR/bundle"
if [ ! -f "$DIR/bundle/chain.json" ]; then
  curl -fsSL "$REPO_RAW/bundle/chain.json" -o "$DIR/bundle/chain.json"
  curl -fsSL "$REPO_RAW/bundle/genesis.tar.bz2" -o "$DIR/bundle/genesis.tar.bz2"
  curl -fsSL "$REPO_RAW/bundle/snapshot-latest.tar.zst" -o "$DIR/bundle/snapshot-latest.tar.zst"
fi
log "extracting genesis into ledger..."
tar -xjf "$DIR/bundle/genesis.tar.bz2" -C "$DIR/ledger/" 2>/dev/null || tar -xjf "$DIR/bundle/genesis.tar.bz2" -C "$DIR/"
cp -f "$DIR/bundle/snapshot-latest.tar.zst" "$DIR/ledger/snapshot/"

# ---------------------------------------------------------------- 4. identity
if [ ! -f "$DIR/identity.json" ]; then
  log "generating node identity keypair..."
  solana-keygen new --no-bip39-passphrase --force -o "$DIR/identity.json" >/dev/null
fi
log "identity: $(solana-keygen pubkey "$DIR/identity.json")"

# ---------------------------------------------------------------- 5. validator mode gate
VOTE_ARGS="--no-vote"
if [ "$MODE" = "validator" ]; then
  log "validator mode: voting requires a registered vote account + BIG stake."
  log "the network team will send the staking pass (info@bigfoot404.biz)."
  log "starting in no-vote follower mode until then (fully syncs, serves RPC)."
fi

# ---------------------------------------------------------------- 6. systemd
ENTRY_ARG=""
[ -n "$ENTRYPOINT" ] && ENTRY_ARG="--entrypoint $ENTRYPOINT"
log "writing systemd unit..."
cat > /etc/systemd/system/big-node.service <<EOF
[Unit]
Description=BIG Chain node (Agave)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$AGAVE_BIN --ledger $DIR/ledger --identity $DIR/identity.json --rpc-port $RPC_PORT --gossip-port $GOSSIP_PORT --dynamic-port-range 8000-8020 --limit-ledger-size 100000000 --snapshot-interval-slots 200 $VOTE_ARGS $ENTRY_ARG --public-rpc
Restart=always
RestartSec=5
Environment=PATH=$PATH
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable big-node >/dev/null
systemctl restart big-node
log "node starting (systemd: big-node)..."

# ---------------------------------------------------------------- 7. health
log "waiting for RPC to come alive..."
for i in $(seq 1 60); do
  SLOT=$(curl -s -X POST "http://127.0.0.1:${RPC_PORT}" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | jq -r '.result // empty' 2>/dev/null || true)
  [ -n "$SLOT" ] && { log "RPC is LIVE — current slot: $SLOT"; break; }
  sleep 3
done

echo ""
log "================ BIG NODE UP ================"
log "RPC:        http://<this-host>:${RPC_PORT}"
log "gossip:     port ${GOSSIP_PORT}"
[ -n "$ENTRYPOINT" ] && log "entrypoint:  $ENTRYPOINT"
[ -z "$ENTRYPOINT" ] && log "no entrypoint: serving from bundled snapshot; add --entrypoint to follow live blocks"
log "logs:       journalctl -u big-node -f"
echo ""
log "NEXT: send your node's public hostname + RPC port to the network team"
log "(info@bigfoot404.biz) so wallet + BIGscan traffic can be routed to it."
