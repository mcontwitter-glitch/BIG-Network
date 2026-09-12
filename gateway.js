// BIG Chain Gateway — public face of the standalone ledger
// /rpc (CORS proxy to validator) · /drip ($BIG faucet) · /stats (chain stats)
const http = require('http');
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const wallet = require('./wallet');

const VAL = 'http://127.0.0.1:8899';
const MINT = new PublicKey('DmQD1wHq2mi2Q6cLzKLbosxGJaqp9QS9qobL5Ge8XaAz');
const TREASURY = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync('treasury.key'))));
const conn = new Connection(VAL, 'confirmed');
const DRIP = 100;
const claims = new Map(); // addr -> last claim ts
const CLAIM_COOLDOWN = 5 * 60 * 1000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}


// ===== BIGscan transaction parser =====
// _rpcRequest returns the FULL JSON-RPC body in this web3.js version — unwrap both shapes.
async function rpc(method, params) {
  const raw = await conn._rpcRequest(method, params);
  if (raw && raw.result !== undefined) return raw.result;
  return raw;
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

async function parseTx(sig) {
  const t = await rpc('getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }]);
  if (!t) return null;
  const out = { sig, slot: t.slot, blockTime: t.blockTime, err: t.meta.err, fee: t.meta.fee, tokenTransfers: [], solTransfers: [] };
  const pre = {}, post = {};
  (t.meta.preTokenBalances || []).forEach(b => { pre[b.accountIndex] = { owner: b.owner, ui: Number(b.uiTokenAmount.uiAmount || 0) }; });
  (t.meta.postTokenBalances || []).forEach(b => { post[b.accountIndex] = { owner: b.owner, ui: Number(b.uiTokenAmount.uiAmount || 0) }; });
  const decs = [], incs = [];
  Object.keys(post).forEach(i => {
    i = Number(i);
    const p = pre[i], q = post[i];
    const d = (q.ui || 0) - (p ? (p.ui || 0) : 0);
    if (d < 0) decs.push({ owner: q.owner, d: -d });
    if (d > 0) incs.push({ owner: q.owner, d });
  });
  if (incs.length && decs.length) {
    out.kind = 'TRANSFER'; out.from = decs[0].owner; out.to = incs[0].owner; out.amount = incs[0].d;
    out.tokenTransfers.push({ from: decs[0].owner, to: incs[0].owner, amount: incs[0].d });
  } else if (incs.length && !decs.length) {
    out.kind = 'GENESIS'; out.from = 'GENESIS'; out.to = incs[0].owner; out.amount = incs[0].d;
    out.tokenTransfers.push({ from: 'GENESIS', to: incs[0].owner, amount: incs[0].d });
  } else if (decs.length) {
    out.kind = 'BURN'; out.from = decs[0].owner; out.to = 'BURN'; out.amount = decs[0].d;
    out.tokenTransfers.push({ from: decs[0].owner, to: 'BURN', amount: decs[0].d });
  } else { out.kind = 'OTHER'; out.amount = 0; }
  const keys = (t.transaction.message.accountKeys || []).map(k => (typeof k === 'string' ? k : k.toBase58()));
  const deltas = keys.map((k, i) => ({ k, d: (t.meta.postBalances[i] || 0) - (t.meta.preBalances[i] || 0) })).filter(x => Math.abs(x.d) > 5000 && x.k !== TOKEN_PROGRAM);
  const dec = deltas.filter(x => x.d < 0).sort((a, b) => a.d - b.d)[0];
  const inc = deltas.filter(x => x.d > 0).sort((a, b) => b.d - a.d)[0];
  if (inc && dec) out.solTransfers.push({ from: dec.k, to: inc.k, amount: inc.d / LAMPORTS_PER_SOL });
  else if (inc) out.solTransfers.push({ from: 'Network Airdrop', to: inc.k, amount: inc.d / LAMPORTS_PER_SOL });
  return out;
}

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url.startsWith('/rpc')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const r = await fetch(VAL, { method: 'POST', headers: {'Content-Type':'application/json'}, body });
        const j = await r.json();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(j));
      } catch(e) { res.writeHead(502); res.end(JSON.stringify({error:'validator unreachable'})); }
    });
    return;
  }

  if (req.url.startsWith('/stats')) {
    try {
      const [v, s, e] = await Promise.all([
        conn.getVersion(), conn.getSlot('confirmed'), conn.getEpochInfo('confirmed')
      ]);
      const supply = await conn.getTokenSupply(MINT);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        chain: 'BIG Chain', solanaCore: v['solana-core'], slot: s,
        epoch: e.epoch, absoluteSlot: e.absoluteSlot,
        supply: supply.value.uiAmount, token: 'BIG', network: 'standalone-ledger'
      }));
    } catch(e) { res.writeHead(502); res.end(JSON.stringify({error:'stats failed'})); }
    return;
  }


  // ===== FAUCET CLAIM PAGE + BIGSCAN =====
  if (req.url === '/' || req.url === '/index.html' || req.url === '/scan' || req.url === '/scan/') {
    const page = req.url.startsWith('/scan') ? 'scan.html' : 'index.html';
    fs.readFile(path.join(__dirname, 'public', page), (e, d) => {
      if (e) { res.writeHead(500); return res.end('page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }

  if (req.url.startsWith('/api/recent')) {
    const limit = Math.min(Number(new URL(req.url, 'http://big').searchParams.get('limit') || 15) || 15, 25);
    (async () => {
      try {
        const sigs = (await rpc('getSignaturesForAddress', [MINT.toBase58(), { limit, commitment: 'confirmed' }])) || [];
        const txs = [];
        for (const s of sigs) { const t = await parseTx(s.sig); if (t) txs.push(t); }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, count: txs.length, transactions: txs }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    })();
    return;
  }

  if (req.url.startsWith('/api/tx')) {
    const sig = new URL(req.url, 'http://big').searchParams.get('sig');
    (async () => {
      try {
        const t = await parseTx(sig);
        if (!t) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Transaction not found on this chain.' })); }
        res.writeHead(200); res.end(JSON.stringify(Object.assign({ ok: true }, t)));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    })();
    return;
  }

  if (req.url.startsWith('/api/address')) {
    const u = new URL(req.url, 'http://big');
    const address = u.searchParams.get('address');
    const wantTxs = u.searchParams.get('txs') === '1';
    (async () => {
      try {
        const b = await wallet.balances(conn, MINT, address);
        const out = { ok: true, address: b.address, sol: b.sol, big: b.big, custodial: b.custodial };
        if (wantTxs) {
          const sigs = (await rpc('getSignaturesForAddress', [b.address, { limit: 20, commitment: 'confirmed' }])) || [];
          const txs = [];
          for (const s of sigs) { const t = await parseTx(s.sig); if (t) txs.push(t); }
          out.transactions = txs;
        }
        res.writeHead(200); res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
    })();
    return;
  }

  if (req.url.startsWith('/drip')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { address } = JSON.parse(body || '{}');
        if (!address) { res.writeHead(400); return res.end(JSON.stringify({ok:false, error:'Paste a Solana address first.'})); }
        let dest;
        try { dest = new PublicKey(address); } catch(e) { res.writeHead(400); return res.end(JSON.stringify({ok:false, error:'That does not look like a valid Solana address.'})); }

        const last = claims.get(address) || 0;
        if (Date.now() - last < CLAIM_COOLDOWN) {
          const wait = Math.ceil((CLAIM_COOLDOWN - (Date.now() - last)) / 60000);
          res.writeHead(429);
          return res.end(JSON.stringify({ok:false, error:'One claim per 5 minutes — come back in ' + wait + ' min.'}));
        }

        // spam guard: refuse if already holding >= DRIP
        // web3.js Buffer-validation bug with mint filter + jsonParsed — use raw RPC JSON instead
        const raw = await conn._rpcRequest('getTokenAccountsByOwner', [dest.toBase58(), { mint: MINT.toBase58() }, { encoding: 'jsonParsed' }]);
        const accs = (raw.result && raw.result.value) || raw.value || [];
        let held = 0;
        accs.forEach(a => held += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0));
        if (held >= DRIP) { res.writeHead(429); return res.end(JSON.stringify({ok:false, error:'You already hold ' + held + ' $BIG — one claim at a time, whale.'})); }

        // manual ATA path — the spl-token getOrCreate wrapper throws TokenAccountNotFoundError on fresh accounts
        try { await conn.requestAirdrop(dest, LAMPORTS_PER_SOL); } catch(e) {} // bonus: fund wallet so it can pay its own fees
        const treasuryATA = await splToken.getAssociatedTokenAddress(MINT, TREASURY.publicKey);
        const destATA = await splToken.getAssociatedTokenAddress(MINT, dest);
        const destInfo = await conn.getAccountInfo(destATA);
        if (!destInfo) {
          const tx = new Transaction().add(
            splToken.createAssociatedTokenAccountInstruction(TREASURY.publicKey, destATA, dest, MINT)
          );
          await sendAndConfirmTransaction(conn, tx, [TREASURY]);
        }
        const sig = await splToken.transfer(conn, TREASURY, treasuryATA, destATA, TREASURY.publicKey, BigInt(DRIP * 1e9), [], undefined, splToken.TOKEN_PROGRAM_ID);
        claims.set(address, Date.now());
        res.writeHead(200);
        res.end(JSON.stringify({ok:true, sig, amount:DRIP, token:'BIG', network:'BIG Chain standalone ledger'}));
      } catch(e) {
        console.error('drip err', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ok:false, error:'Faucet hiccup — try again in a minute.'}));
      }
    });
    return;
  }

  // ===== BIG WALLET SERVICE — chain-backed custodial wallets =====
  if (req.url.startsWith('/wallet/create') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { address, phrase } = await wallet.createWallet(conn, MINT, TREASURY);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, address, phrase, token: 'BIG', network: 'BIG Chain', custodial: 'BIG network asset — keys held on the ledger volume' }));
      } catch (e) {
        console.error('wallet create err', e.message);
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'Wallet creation failed — try again.' }));
      }
    });
    return;
  }

  if (req.url.startsWith('/wallet/balance')) {
    (async () => {
      try {
        const u = new URL(req.url, 'http://x');
        const address = u.searchParams.get('address');
        if (!address) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'address= required' })); }
        const b = await wallet.balances(conn, MINT, address);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, ...b }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Bad address or chain unreachable.' }));
      }
    })();
    return;
  }

  if (req.url.startsWith('/wallet/send') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { from, to, amount } = JSON.parse(body || '{}');
        if (!from || !to || !amount) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'from, to, amount required' })); }
        const sig = await wallet.sendBig(conn, MINT, from, to, amount);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, sig, amount: Number(amount), token: 'BIG', network: 'BIG Chain' }));
      } catch (e) {
        console.error('wallet send err', e.message);
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/wallet/phrase')) {
    (async () => {
      try {
        const u = new URL(req.url, 'http://x');
        // optional gate: set BIG_PHRASE_KEY env (pod) to require ?key= match before going public
        const gate = process.env.BIG_PHRASE_KEY;
        if (gate && u.searchParams.get('key') !== gate) {
          res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: 'key required' }));
        }
        const address = u.searchParams.get('address');
        if (!address) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'address= required' })); }
        const phrase = wallet.revealPhrase(address);
        if (!phrase) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'No seed phrase for this wallet (legacy wallet — use the custodial balance/send only).' })); }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, address, phrase, path: "m/44'/501'/0'/0'", note: 'Import into Phantom/Solflare/Backpack with this 12-word phrase, pointed at the BIG network RPC.' }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  if (req.url.startsWith('/wallet/list')) {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, count: wallet.listWallets().length, wallets: wallet.listWallets() }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({error:'BIG Chain gateway — use / (faucet), /scan (explorer), /rpc, /drip, /stats, /api/tx, /api/address, /api/recent, /wallet/create, /wallet/balance, /wallet/phrase, /wallet/send, /wallet/list'}));
}).listen(9090, '0.0.0.0', () => console.log('gateway on 9090'));
