#!/bin/bash
# BIG Network validator pod boot — one-shot, idempotent (safe on pod restarts).
# Expects env: STATE_URL (signed URL to bigchain-state.zip: ledger + treasury/mint keys)
mkdir -p /workspace/bigchain
exec >> /workspace/bigchain/boot.log 2>&1
set -x

# 1) app code
if [ ! -d /workspace/bigchain/app/.git ]; then
  git clone --depth 1 https://github.com/mcontwitter-glitch/BIG-Network.git /workspace/bigchain/app
fi
cd /workspace/bigchain/app

# 2) restore chain state on first boot (volume empty = fresh volume, not restart)
if [ ! -f /workspace/bigchain/ledger/genesis.bin ]; then
  [ -z "$STATE_URL" ] && { echo "FATAL: STATE_URL not set and no ledger on volume"; exit 1; }
  curl -fsSL -o /tmp/state.zip "$STATE_URL"
  (cd /workspace/bigchain && unzip -o /tmp/state.zip && rm -f /tmp/state.zip)
fi
cp -f /workspace/bigchain/treasury.key /workspace/bigchain/mint.key /workspace/bigchain/keys.env /workspace/bigchain/chain.json /workspace/bigchain/app/ 2>/dev/null || true

# 3) node 20
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
node -v
npm install --no-audit --no-fund

# 4) agave v2.1.21 (tarball cached on volume, integrity-checked)
if [ ! -x /usr/local/bin/solana-test-validator ]; then
  if [ ! -f /workspace/bigchain/solana-release.tar.bz2 ] || ! tar -tjf /workspace/bigchain/solana-release.tar.bz2 >/dev/null 2>&1; then
    echo "agave tarball missing or corrupt — downloading fresh"
    rm -f /workspace/bigchain/solana-release.tar.bz2
    curl -fsSL -o /workspace/bigchain/solana-release.tar.bz2 \
      https://github.com/anza-xyz/agave/releases/download/v2.1.21/solana-release-x86_64-unknown-linux-gnu.tar.bz2
  fi
  tar -xjf /workspace/bigchain/solana-release.tar.bz2 -C /tmp || { echo "FATAL: agave extract failed"; exit 1; }
  cp /tmp/solana-release*/bin/solana-test-validator /usr/local/bin/ || { echo "FATAL: validator install failed"; exit 1; }
fi
solana-test-validator --version

# 5) gateway bind patch (proxy needs 0.0.0.0; VAL rpc stays 127.0.0.1)
sed -i "s/}).listen(9090, '127.0.0.1'/}).listen(9090, '0.0.0.0'/" gateway.js
grep -n "listen(9090" gateway.js

# 6) supervisor — keeps validator + gateway + faucet alive
cat > /workspace/bigchain/big-supervisor.sh <<'EOS'
#!/bin/bash
while true; do
  if ! pgrep -f solana-test-validator >/dev/null; then
    nohup solana-test-validator --ledger /workspace/bigchain/ledger --bind-address 0.0.0.0 --rpc-port 8899 > /workspace/bigchain/validator.log 2>&1 &
  fi
  cd /workspace/bigchain/app
  if ! pgrep -f gateway.js >/dev/null; then nohup node gateway.js > /workspace/bigchain/gateway.log 2>&1 & fi
  if ! pgrep -f faucet.js >/dev/null; then nohup node faucet.js > /workspace/bigchain/faucet.log 2>&1 & fi
  sleep 10
done
EOS
chmod +x /workspace/bigchain/big-supervisor.sh
nohup /workspace/bigchain/big-supervisor.sh > /dev/null 2>&1 &

# 7) wait for RPC then bootstrap (idempotent: rewrites chain.json from ledger)
for i in $(seq 1 60); do
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:8899 && break
  sleep 2
done
cd /workspace/bigchain/app && node bootstrap.js || echo "bootstrap retry needed (fundloop pattern)"
echo BOOT_DONE
# keep container alive: exec replaces the shell with the supervisor loop
exec /workspace/bigchain/big-supervisor.sh
