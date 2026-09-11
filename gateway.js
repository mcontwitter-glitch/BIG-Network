// BIG Chain Gateway — public face of the standalone ledger
// /rpc (CORS proxy to validator) · /drip ($BIG faucet) · /stats (chain stats)
const http = require('http');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
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

        const treasuryATA = await splToken.getAssociatedTokenAddress(MINT, TREASURY.publicKey);
        const destATA = await splToken.getOrCreateAssociatedTokenAccount(
          conn, TREASURY, MINT, dest, false, undefined, undefined,
          splToken.ASSOCIATED_TOKEN_PROGRAM_ID, splToken.TOKEN_PROGRAM_ID
        );
        const sig = await splToken.transfer(conn, TREASURY, treasuryATA, destATA.address, TREASURY.publicKey, BigInt(DRIP * 1e9), [], undefined, splToken.TOKEN_PROGRAM_ID);
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

  res.writeHead(404); res.end(JSON.stringify({error:'BIG Chain gateway — use /rpc, /drip, /stats'}));
}).listen(9090, '0.0.0.0', () => console.log('gateway on 9090'));
