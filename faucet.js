// BIG Chain Testnet Faucet — drips 100 $BIG (devnet) per claim
// Devnet prototype only: $BIG has zero value. Treasury key is a devnet-only hot key.
const solana = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

const RPC = 'https://api.devnet.solana.com';
const MINT = new solana.PublicKey('DmQD1wHq2mi2Q6cLzKLbosxGJaqp9QS9qobL5Ge8XaAz');
const DRIP = 100; // $BIG per claim

const TREASURY_SECRET = [131,108,112,21,235,68,5,165,35,35,134,248,126,74,29,106,125,220,19,45,153,138,46,204,50,3,54,182,120,49,164,148,196,75,71,126,225,39,104,129,162,239,118,143,226,221,82,123,198,176,109,248,46,14,48,141,24,71,163,180,49,22,237,207];

module.exports = async function bigChainFaucet(req, res) {
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const address = body.address;

        if (!address || typeof address !== 'string') {
            return res.status(400).json({ ok: false, error: 'Paste a Solana address first.' });
        }
        let dest;
        try { dest = new solana.PublicKey(address); } catch (e) {
            return res.status(400).json({ ok: false, error: 'That does not look like a valid Solana address.' });
        }
        const treasury = solana.Keypair.fromSecretKey(Buffer.from(TREASURY_SECRET));

        const conn = new solana.Connection(RPC, 'confirmed');

        // spam guard: refuse if recipient already holds >= DRIP $BIG
        const destAccounts = await conn.getTokenAccountsByOwner(dest, { mint: MINT }, { encoding: 'jsonParsed' });
        let held = 0;
        (destAccounts.value || []).forEach(a => { held += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0); });
        if (held >= DRIP) {
            return res.status(429).json({ ok: false, error: 'You already hold ' + held + ' $BIG — one claim at a time, whale.' });
        }

        const treasuryATA = await splToken.getAssociatedTokenAddress(MINT, treasury.publicKey);
        const destATA = await splToken.getOrCreateAssociatedTokenAccount(
            conn, treasury, MINT, dest, false, undefined, undefined,
            splToken.ASSOCIATED_TOKEN_PROGRAM_ID, splToken.TOKEN_PROGRAM_ID
        );

        const sig = await splToken.transfer(
            conn, treasury, treasuryATA, destATA.address, treasury.publicKey,
            BigInt(DRIP * 1e9), [], undefined, splToken.TOKEN_PROGRAM_ID
        );

        return res.status(200).json({ ok: true, sig, amount: DRIP, token: 'BIG', network: 'devnet' });
    } catch (e) {
        console.error('faucet error', e.message);
        return res.status(500).json({ ok: false, error: 'Faucet hiccup — devnet may be sleepy, try again in a minute.' });
    }
};
