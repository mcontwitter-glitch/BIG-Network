#!/bin/bash
# BIG Network validator pod boot — v3.1: RESUME-FIRST (never wipe a live ledger) + dpkg repair.
# Expects env: STATE_URL (signed URL to bigchain-state.zip: treasury/mint keys)
mkdir -p /workspace/bigchain
exec >> /workspace/bigchain/boot.log 2>&1
set -x

# 1) app code (fresh clone OR pull latest main so restarts pick up new code)
if [ ! -d /workspace/bigchain/app/.git ]; then
  git clone --depth 1 https://github.com/mcontwitter-glitch/BIG-Network.git /workspace/bigchain/app
else
  (cd /workspace/bigchain/app && git fetch --depth 1 origin main && git reset --hard origin/main) || true
fi
mkdir -p /workspace/bigchain/wallets   # BIG wallet store — volume-backed, never in repo
chmod 700 /workspace/bigchain/wallets 2>/dev/null || true
cd /workspace/bigchain/app

# 2) restore KEYS from the state zip if missing (keys only — NEVER the ledger snapshot)
if [ ! -f /workspace/bigchain/treasury.key ]; then
  [ -z "$STATE_URL" ] && { echo "FATAL: STATE_URL not set and no keys on volume"; exit 1; }
  curl -fsSL -o /tmp/state.zip "$STATE_URL"
  (cd /workspace/bigchain && unzip -o /tmp/state.zip && rm -f /tmp/state.zip) || true
fi
cp -f /workspace/bigchain/treasury.key /workspace/bigchain/mint.key /workspace/bigchain/keys.env /workspace/bigchain/chain.json /workspace/bigchain/app/ 2>/dev/null || true

# 3) node 20
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -c2-3)" -lt 20 ]; then
  export DEBIAN_FRONTEND=noninteractive
  dpkg --configure -a >/dev/null 2>&1 || true   # v3.1: repair dpkg after interrupted boots
  rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock* /var/cache/apt/archives/lock 2>/dev/null || true
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  dpkg --configure -a >/dev/null 2>&1 || true
  apt-get install -y nodejs >/dev/null
fi
node -v
npm install --no-audit --no-fund

# 4) agave v2.1.21 (tarball cached on volume, integrity-checked)
if [ ! -x /usr/local/bin/solana-test-validator ]; then
  if [ ! -f /workspace/bigchain/solana-release.tar.bz2 ] || ! tar -tjf /workspace/bigchain/solana-release.tar.bz2 >/dev/null 2>&1; then
    echo "agave tarball missing or corrupt — downloading fresh (resumable loop)"
    rm -f /workspace/bigchain/solana-release.tar.bz2
    ok=0
    for try in $(seq 1 60); do
      curl -fsSL -C - --max-time 600 -o /workspace/bigchain/solana-release.tar.bz2 \
        https://github.com/anza-xyz/agave/releases/download/v2.1.21/solana-release-x86_64-unknown-linux-gnu.tar.bz2 && { ok=1; break; }
      echo "download attempt $try incomplete ($(stat -c%s /workspace/bigchain/solana-release.tar.bz2 2>/dev/null || echo 0) bytes) — resuming"
      sleep 3
    done
    [ "$ok" = 1 ] || { echo "FATAL: agave download failed after retries"; exit 1; }
    sz=$(stat -c%s /workspace/bigchain/solana-release.tar.bz2)
    [ "$sz" = "298782636" ] || { echo "FATAL: agave tarball size mismatch ($sz != 298782636)"; exit 1; }
    tar -tjf /workspace/bigchain/solana-release.tar.bz2 >/dev/null 2>&1 || { echo "FATAL: downloaded tarball still corrupt"; exit 1; }
  fi
  tar -xjf /workspace/bigchain/solana-release.tar.bz2 -C /tmp || { echo "FATAL: agave extract failed"; exit 1; }
  cp /tmp/solana-release*/bin/solana-test-validator /usr/local/bin/ || { echo "FATAL: validator install failed"; exit 1; }
fi
solana-test-validator --version

# 5) gateway bind patch (proxy needs 0.0.0.0; VAL rpc stays 127.0.0.1)
sed -i "s/}).listen(9090, '127.0.0.1'/}).listen(9090, '0.0.0.0'/" gateway.js
grep -n "listen(9090" gateway.js

# 6) RESUME-FIRST LAW (v3): an existing ledger with rocksdb = live chain data —
#    NEVER delete it. Only a missing ledger falls back to fresh genesis.
LEDGER_DIR=/workspace/bigchain/ledger
RESUME=0
if [ -d "$LEDGER_DIR/rocksdb" ]; then
  RESUME=1
  echo "LEDGER FOUND — RESUME MODE (no wipe, no fresh genesis)"
else
  find "$LEDGER_DIR" -mindepth 1 -delete 2>/dev/null
  echo "no ledger on volume — fresh-genesis path (partial ledger cleared)"
fi

# 7) supervisor — keeps validator + gateway + faucet alive
cat > /workspace/bigchain/big-supervisor.sh <<EOS
#!/bin/bash
while true; do
  if ! pgrep -f solana-test-validator >/dev/null 2>&1; then
    nohup solana-test-validator --ledger $LEDGER_DIR --bind-address 0.0.0.0 --rpc-port 8899 --account-index spl-token-mint --account-index spl-token-owner > /workspace/bigchain/validator.log 2>&1 &
  fi
  cd /workspace/bigchain/app
  if ! pgrep -f gateway.js >/dev/null 2>&1; then nohup node gateway.js > /workspace/bigchain/gateway.log 2>&1 & fi
  if ! pgrep -f faucet.js >/dev/null 2>&1; then nohup node faucet.js > /workspace/bigchain/faucet.log 2>&1 & fi
  sleep 10
done
EOS
chmod +x /workspace/bigchain/big-supervisor.sh
nohup /workspace/bigchain/big-supervisor.sh > /dev/null 2>&1 &

# 8) wait for RPC; bootstrap ONLY on fresh genesis — never top-up a resumed chain
for i in $(seq 1 120); do
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:8899 && break
  sleep 2
done
if [ "$RESUME" = "1" ]; then
  node -e "
    const {Connection, Keypair} = require('@solana/web3.js');
    const fs = require('fs');
    const c = new Connection('http://127.0.0.1:8899','confirmed');
    (async () => {
      const slot = await c.getSlot('confirmed');
      console.log('RESUME OK — slot', slot);
      const km = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('mint.key'))));
      const info = await c.getAccountInfo(km.publicKey);
      console.log('mint account present:', !!info);
    })().catch(e => { console.error('RESUME VERIFY FAILED:', e.message); process.exit(1); });
  " || echo "resume verify failed — check validator.log"
else
  node bootstrap.js
fi
echo BOOT_DONE
exec /workspace/bigchain/big-supervisor.sh
