#!/usr/bin/env bash
# ============================================================================
#  BIG Chain — Node Installer
#  Spins up a BIG Chain RPC node on any fresh Ubuntu 20.04+/Debian 11+ box
#  (or any cloud pod) in ~3 minutes.
#
#  One command (RPC replica — helps network speed by serving reads):
#    curl -fsSL https://raw.githubusercontent.com/mcontwitter-glitch/BIG-Network/main/install-node.sh | sudo bash
#
#  Join the live seed:
#    DEFAULT: every install now tracks the live seed automatically (HTTP
#    catch-up — no direct gossip needed, works through Runpod/Docker proxies).
#    If the seed exposes a direct gossip port (public IP), real-time instead:
#      curl -fsSL .../install-node.sh | sudo bash -s -- --entrypoint seed-host:8001
#    Disable seed tracking entirely: --seed off
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
#    --entrypoint HOST:PORT   seed gossip address — real-time sync when the
#                             seed exposes direct TCP/UDP (public IP)
#    --seed GATEWAY_URL      seed gateway to catch up from (default: the live
#                             BIG seed; polls /stats every 10 min and refreshes
#                             the local ledger from the seed snapshot when
#                             behind). "--seed off" disables.
#    --mode rpc|validator     default rpc
#    --dir /opt/big-chain     install location
#    --rpc-port 8899          local RPC port
# ============================================================================
set -euo pipefail

MODE="rpc"
ENTRYPOINT=""
DIR="/opt/big-chain"
RPC_PORT="8899"
FOREGROUND=0
SEED_GW="https://8f2dvht9slxsi3-9090.proxy.runpod.net"
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
    --foreground) FOREGROUND=1; shift ;;
    --seed) SEED_GW="${2:-}"; shift 2 ;;
    --seed=*) SEED_GW="${1#*=}"; shift ;;
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

# ---------------------------------------------------------------- 6. launch
ENTRY_ARG=""
[ -n "$ENTRYPOINT" ] && ENTRY_ARG="--entrypoint $ENTRYPOINT"
VAL_CMD="$AGAVE_BIN --ledger $DIR/ledger --identity $DIR/identity.json --rpc-port $RPC_PORT --gossip-port $GOSSIP_PORT --dynamic-port-range 8000-8020 --limit-ledger-size 100000000 --snapshot-interval-slots 200 $VOTE_ARGS $ENTRY_ARG --public-rpc"
printf '%s\n' "$VAL_CMD" > "$DIR/val-cmd.txt"

if [ "$FOREGROUND" -eq 1 ]; then
  # container mode (Runpod/Docker - no systemd): run directly, log to file
  log "foreground/container mode - starting validator directly..."
  nohup $VAL_CMD > "$DIR/node.log" 2>&1 &
  echo $! > "$DIR/node.pid"
else
  log "writing systemd unit..."
  cat > /etc/systemd/system/big-node.service <<UNIT
[Unit]
Description=BIG Chain node (Agave)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$VAL_CMD
Restart=always
RestartSec=5
Environment=PATH=$PATH
User=root

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable big-node >/dev/null
  systemctl restart big-node
  log "node starting (systemd: big-node)..."
fi

# ---------------------------------------------------------------- 7. health
log "waiting for RPC to come alive..."
for i in $(seq 1 60); do
  SLOT=$(curl -s -X POST "http://127.0.0.1:${RPC_PORT}" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | jq -r '.result // empty' 2>/dev/null || true)
  [ -n "$SLOT" ] && { log "RPC is LIVE — current slot: $SLOT"; break; }
  sleep 3
done

# ---------------------------------------------------------------- 7. seed catch-up
# The Runpod HTTP proxy cannot carry agave gossip (UDP/TCP), so without a
# direct --entrypoint the node stays fresh by refreshing its ledger state
# from the seed gateway instead: poll /stats, pull /snapshot, reboot the node.
if [ -z "$ENTRYPOINT" ] && [ "$SEED_GW" != "off" ] && [ -n "$SEED_GW" ]; then
  log "installing seed catch-up (tracks $SEED_GW every 10 min)..."
  cat > "$DIR/catchup.sh" <<CATCH
#!/usr/bin/env bash
# BIG Chain catch-up - refresh local ledger state from the live seed.
DIR="__DIR__"
RPC_PORT="__RPC__"
SEED_GW="__SEED__"
LOG="\$DIR/catchup.log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[\$(ts)] \$*" >> "\$LOG"; }
local_slot=\$(curl -s --max-time 8 http://127.0.0.1:\$RPC_PORT -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | jq -r '.result // 0')
seed_slot=\$(curl -s --max-time 15 "\$SEED_GW/stats" | jq -r '.slot // 0')
[ "\$local_slot" -gt 0 ] 2>/dev/null || { log "local RPC not answering, skipping"; exit 0; }
[ "\$seed_slot" -gt 0 ]  2>/dev/null || { log "seed unreachable, skipping"; exit 0; }
if [ "\$((seed_slot - local_slot))" -le 300 ]; then log "fresh (local=\$local_slot seed=\$seed_slot)"; exit 0; fi
log "behind: local=\$local_slot seed=\$seed_slot -> refreshing snapshot"
curl -fsSL --max-time 120 "\$SEED_GW/snapshot" -o "\$DIR/catchup-bundle.tar.gz" || { log "snapshot fetch failed"; exit 1; }
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet big-node 2>/dev/null; then
  systemctl stop big-node
else
  [ -f "\$DIR/node.pid" ] && kill "\$(cat \$DIR/node.pid)" 2>/dev/null; sleep 2
fi
rm -rf "\$DIR/ledger/rocksdb" "\$DIR/ledger/snapshot"
mkdir -p "\$DIR/ledger/snapshot"
tar -xzf "\$DIR/catchup-bundle.tar.gz" -C "\$DIR/ledger/" || { log "extract failed"; exit 1; }
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && [ -f /etc/systemd/system/big-node.service ]; then
  systemctl start big-node
else
  nohup \$(cat "\$DIR/val-cmd.txt") > "\$DIR/node.log" 2>&1 & echo \$! > "\$DIR/node.pid"
fi
log "restarted on refreshed state (seed was slot \$seed_slot)"
CATCH
  # fill in this node's actual values inside catchup.sh
  sed -i "s|__DIR__|$DIR|g; s|__RPC__|$RPC_PORT|g; s|__SEED__|$SEED_GW|g" "$DIR/catchup.sh"
  chmod +x "$DIR/catchup.sh"
  if [ "$FOREGROUND" -eq 1 ]; then
    # container mode: background loop instead of cron
    nohup bash -c "while sleep 600; do '$DIR/catchup.sh' >/dev/null 2>&1; done" > "$DIR/catchup-loop.log" 2>&1 &
    echo $! > "$DIR/catchup-loop.pid"
    log "catch-up loop running (pid $(cat $DIR/catchup-loop.pid))"
  else
    echo "*/10 * * * * root $DIR/catchup.sh" > /etc/cron.d/big-chain
    chmod 644 /etc/cron.d/big-chain
    log "catch-up cron installed (/etc/cron.d/big-chain)"
  fi
elif [ -n "$ENTRYPOINT" ]; then
  log "entrypoint set: real-time gossip sync, no catch-up loop needed"
elif [ "$SEED_GW" = "off" ]; then
  log "seed tracking disabled (--seed off) - node serves from local state only"
fi

echo ""
log "================ BIG NODE UP ================"
log "RPC:        http://<this-host>:${RPC_PORT}"
log "gossip:     port ${GOSSIP_PORT}"
[ -n "$ENTRYPOINT" ] && log "entrypoint:  $ENTRYPOINT (real-time gossip)"
[ -z "$ENTRYPOINT" ] && [ "$SEED_GW" != "off" ] && log "seed sync:   $SEED_GW (catch-up every 10 min)"
[ "$SEED_GW" = "off" ] && log "seed sync:   disabled"
if [ "$FOREGROUND" -eq 1 ]; then log "logs:       tail -f $DIR/node.log"; else log "logs:       journalctl -u big-node -f"; fi
echo ""
log "NEXT: send your node's public hostname + RPC port to the network team"
log "(info@bigfoot404.biz) so wallet + BIGscan traffic can be routed to it."
