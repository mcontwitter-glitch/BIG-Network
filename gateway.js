// BIG Chain Gateway — public face of the standalone ledger
// /rpc (CORS proxy to validator) · /drip ($BIG faucet) · /stats (chain stats)
const http = require('http');
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const fs = require('fs');

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
        const accs = await conn._rpcRequest('getTokenAccountsByOwner', [dest.toBase58(), { mint: MINT.toBase58() }, { encoding: 'jsonParsed' }]);
        let held = 0;
        (accs.value||[]).forEach(a => held += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0));
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
        const address = await wallet.createWallet(conn, MINT, TREASURY);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, address, token: 'BIG', network: 'BIG Chain', custodial: 'BIG network asset — keys held on the ledger volume' }));
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

  if (req.url.startsWith('/wallet/list')) {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, count: wallet.listWallets().length, wallets: wallet.listWallets() }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({error:'BIG Chain gateway — use /rpc, /drip, /stats, /wallet/create, /wallet/balance, /wallet/send, /wallet/list'}));
}).listen(9090, '0.0.0.0', () => console.log('gateway on 9090'));
