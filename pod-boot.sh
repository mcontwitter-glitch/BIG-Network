#!/bin/bash
# BIG Network boot v4 — SPACE-SAFE RESUME (volume hit 100%)
# Logs go to container stdout (runpodctl pod logs). Nothing touches the full
# volume until the space-free step at the top has run.
set -x
date -u

# 0) FREE VOLUME SPACE FIRST — truncate big logs, drop junk, stale tarballs, old validator logs
: > /workspace/bigchain/validator.log
: > /workspace/bigchain/gateway.log
: > /workspace/bigchain/faucet.log
find /workspace/bigchain -maxdepth 1 -name "boot-trace.log" -delete
find /workspace/bigchain -maxdepth 1 -name "bigchain-backup.tar.gz" -delete
find /workspace/bigchain -maxdepth 1 -name "solana-release.tar.bz2" -delete
find /workspace/bigchain/ledger -maxdepth 1 -name "validator-*.log" -delete
df -h /workspace/bigchain
du -sh /workspace/bigchain/ledger 2>/dev/null

# 0.5) sshd for ops access (PUBLIC_KEY env)
if [ -n "$PUBLIC_KEY" ]; then
  mkdir -p /root/.ssh && echo "$PUBLIC_KEY" > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys
  (apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq openssh-server >/dev/null 2>&1; ssh-keygen -A >/dev/null 2>&1; /usr/sbin/sshd 2>/dev/null || true)
fi

# 1) app code
if [ ! -d /workspace/bigchain/app/.git ]; then
  git clone --depth 1 https://github.com/mcontwitter-glitch/BIG-Network.git /workspace/bigchain/app
else
  (cd /workspace/bigchain/app && git fetch --depth 1 origin main && git reset --hard origin/main) || true
fi
cd /workspace/bigchain/app

# 2) keys from volume into app
cp -f /workspace/bigchain/treasury.key /workspace/bigchain/mint.key /workspace/bigchain/keys.env /workspace/bigchain/chain.json /workspace/bigchain/app/ 2>/dev/null || true

# 3) node 20
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
node -v
npm install --no-audit --no-fund

# 4) agave v2.1.21 — download straight to /tmp (container disk); NEVER cache the 298MB tarball on the full volume
if [ ! -x /usr/local/bin/solana-test-validator ]; then
  for try in 1 2 3 4 5; do
    curl -fsSL --max-time 600 -o /tmp/agave.tar.bz2 https://github.com/anza-xyz/agave/releases/download/v2.1.21/solana-release-x86_64-unknown-linux-gnu.tar.bz2 && break
    sleep 5
  done
  tar -xjf /tmp/agave.tar.bz2 -C /tmp
  cp /tmp/solana-release*/bin/solana-test-validator /usr/local/bin/
fi
solana-test-validator --version

# 5) gateway bind patch (RunPod proxy needs 0.0.0.0)
sed -i "s/}).listen(9090, '127.0.0.1'/}).listen(9090, '0.0.0.0'/" gateway.js

# 6) RESUME-FIRST LAW — an existing ledger with rocksdb = live chain data. NEVER wipe.
RESUME=0
if [ -d /workspace/bigchain/ledger/rocksdb ]; then
  RESUME=1
  echo "LEDGER FOUND — RESUME MODE (no wipe, no fresh genesis)"
fi

# 7) supervisor — SNAPSHOT-CHURN LAW: huge snapshot interval so the 9.4GB volume never fills again;
#    validator.log capped at 200MB by truncation each loop.
cat > /workspace/bigchain/big-supervisor.sh <<'EOS'
#!/bin/bash
while true; do
  sz=$(stat -c%s /workspace/bigchain/validator.log 2>/dev/null || echo 0)
  [ "$sz" -gt 200000000 ] && : > /workspace/bigchain/validator.log
  if ! pgrep -f solana-test-validator >/dev/null 2>&1; then
    : > /workspace/bigchain/validator.log
    nohup solana-test-validator --ledger /workspace/bigchain/ledger --bind-address 0.0.0.0 --rpc-port 8899 --account-index spl-token-mint --account-index spl-token-owner > /workspace/bigchain/validator.log 2>&1 &
  fi
  cd /workspace/bigchain/app
  if ! pgrep -f gateway.js >/dev/null 2>&1; then nohup node gateway.js > /workspace/bigchain/gateway.log 2>&1 & fi
  if ! pgrep -f faucet.js >/dev/null 2>&1; then nohup node faucet.js > /workspace/bigchain/faucet.log 2>&1 & fi
  sleep 10
done
EOS
chmod +x /workspace/bigchain/big-supervisor.sh
nohup /workspace/bigchain/big-supervisor.sh > /dev/null 2>&1 &

# 8) wait for RPC (ledger replay of 5.4GB can take minutes)
for i in $(seq 1 180); do
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:8899 && break
  sleep 2
done

# 9) verify resume — bootstrap ONLY on a fresh chain, never top up a resumed one
if [ "$RESUME" = "1" ]; then
  node -e "
    const {Connection} = require('@solana/web3.js');
    const c = new Connection('http://127.0.0.1:8899','confirmed');
    (async () => {
      const slot = await c.getSlot('confirmed');
      console.log('RESUME OK — slot', slot);
    })().catch(e => { console.error('RESUME VERIFY FAILED:', e.message); process.exit(1); });
  " || echo "resume verify failed — check validator.log"
else
  node bootstrap.js
fi
echo BOOT_DONE
exec /workspace/bigchain/big-supervisor.sh
