// BIG Network speed test — TPS + latency benchmark (poll-only, no websocket)
const {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction
} = require('@solana/web3.js');
const fs = require('fs');

const RPC = 'http://127.0.0.1:8899';
const conn = new Connection(RPC, { commitment: 'confirmed', wsEndpoint: 'http://127.0.0.1:8899' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function confirmByPolling(sig, timeoutMs = 30000) {
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const res = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const st = res && res.value && res.value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      return { ok: true, ms: Date.now() - t0 };
    }
    if (st && st.err) return { ok: false, ms: Date.now() - t0, err: JSON.stringify(st.err) };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, err: 'timeout' };
    await sleep(120);
  }
  return { ok: false, ms: Date.now() - t0, err: 'rounds' };
}

async function main() {
  const out = { started: new Date().toISOString() };

  const version = await conn.getVersion();
  const epochInfo = await conn.getEpochInfo();
  out.chain = { version: `${version['solana-core']}`, epoch: epochInfo.epoch, slot: epochInfo.absoluteSlot, health: 'ok' };

  // --- test wallets ---
  const walletA = Keypair.generate();
  const walletB = Keypair.generate();
  const sigA = await conn.requestAirdrop(walletA.publicKey, 50 * LAMPORTS_PER_SOL);
  const cA = await confirmByPolling(sigA);
  if (!cA.ok) throw new Error('airdrop A failed: ' + cA.err);
  const sigB = await conn.requestAirdrop(walletB.publicKey, 50 * LAMPORTS_PER_SOL);
  const cB = await confirmByPolling(sigB);
  if (!cB.ok) throw new Error('airdrop B failed: ' + cB.err);
  console.log('airdrops confirmed');

  const buildTx = (src, dst, lam) => {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: src.publicKey, toPubkey: dst.publicKey, lamports: lam
    }));
    return tx;
  };

  // --- SEQUENTIAL TEST: 20 confirmed transfers, full round-trip latency each ---
  const seq = [];
  for (let i = 0; i < 20; i++) {
    const src = i % 2 === 0 ? walletA : walletB;
    const dst = i % 2 === 0 ? walletB : walletA;
    const t0 = Date.now();
    try {
      const tx = buildTx(src, dst, 0.01 * LAMPORTS_PER_SOL);
      const sig = await conn.sendTransaction(tx, [src]);
      const c = await confirmByPolling(sig);
      const ms = Date.now() - t0;
      if (c.ok) seq.push(ms);
      else console.log('seq fail', i, c.err);
    } catch (e) { console.log('seq err', i, e.message); }
    process.stdout.write(`seq ${i + 1}/20 ${seq.length ? seq[seq.length - 1] : '?'}ms\r`);
  }
  const s = seq.slice().sort((a, b) => a - b);
  out.sequential = {
    count: seq.length,
    avg_ms: Math.round(seq.reduce((a, b) => a + b, 0) / seq.length),
    min_ms: s[0], max_ms: s[s.length - 1],
    p50: s[Math.floor(s.length / 2)],
    tps: +(1000 / (seq.reduce((a, b) => a + b, 0) / seq.length)).toFixed(2),
    latencies: seq
  };
  console.log('\nsequential done:', JSON.stringify(out.sequential));

  // --- BURST TEST: 30 txs fired concurrently with a fresh blockhash ---
  const burstN = 30;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const txs = [];
  for (let i = 0; i < burstN; i++) {
    const src = i % 2 === 0 ? walletA : walletB;
    const dst = i % 2 === 0 ? walletB : walletA;
    const tx = new Transaction({ blockhash, lastValidBlockHeight }).add(SystemProgram.transfer({
      fromPubkey: src.publicKey, toPubkey: dst.publicKey, lamports: 0.001 * LAMPORTS_PER_SOL
    }));
    tx.sign(src);
    txs.push(tx);
  }
  const tSend0 = Date.now();
  const sigs = await Promise.all(txs.map(tx =>
    conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }).catch(e => { console.log('send err:', e.message); return null; })
  ));
  const sendTime = Date.now() - tSend0;
  const okSigs = sigs.filter(Boolean);
  // poll all at once
  let confirmed = 0;
  const tConf0 = Date.now();
  for (let round = 0; round < 100; round++) {
    const res = await conn.getSignatureStatuses(okSigs, { searchTransactionHistory: false });
    confirmed = res.value.filter(x => x && (x.confirmationStatus === 'confirmed' || x.confirmationStatus === 'finalized')).length;
    if (confirmed >= okSigs.length) break;
    await sleep(150);
  }
  const confTime = Date.now() - tConf0;
  const totalMs = (Date.now() - tSend0);
  out.burst = {
    count: burstN, sent: okSigs.length, submitted_ms: sendTime,
    all_confirmed: confirmed >= okSigs.length, confirmed_count: confirmed,
    confirm_ms: confTime,
    effective_tps: +((confirmed || okSigs.length) / (totalMs / 1000)).toFixed(2),
    submit_rate_tps: +(okSigs.length / (sendTime / 1000)).toFixed(2)
  };
  console.log('burst done:', JSON.stringify(out.burst));

  // --- BLOCK TIME: sample slot timestamps ---
  const cur = await conn.getSlot('confirmed');
  const slots = [];
  for (let k = 0; k <= 12; k++) {
    try { slots.push({ slot: cur - k, time: await conn.getBlockTime(cur - k) }); } catch (e) {}
  }
  slots.sort((a, b) => a.slot - b.slot);
  const gaps = [];
  for (let i = 1; i < slots.length; i++) {
    const ds = slots[i].slot - slots[i - 1].slot;
    const dt = slots[i].time - slots[i - 1].time;
    if (ds > 0) gaps.push(dt / ds);
  }
  out.blocks = {
    sampled: slots.length,
    avg_block_seconds: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3),
    target: 0.4
  };
  console.log('blocks done:', JSON.stringify(out.blocks));

  out.finished = new Date().toISOString();
  fs.writeFileSync('bench-results.json', JSON.stringify(out, null, 2));
  console.log('ALL DONE');
}

main().catch(e => { console.error('BENCH FAILED:', e.message); process.exit(1); });
