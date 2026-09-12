// BIG Wallet Service — custodial network wallets, backed by the BIG chain.
// A BIG network asset: keypairs live ONLY on the ledger volume (/workspace/bigchain/wallets),
// never in the repo. Every wallet is a real chain account holding real $BIG.
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { generateMnemonic, mnemonicToSeedSync } = require('@scure/bip39');
const splToken = require('@spl-token');
const { wordlist } = require('@scure/bip39/wordlists/english');
const { derivePath } = require('ed25519-hd-key');
const fs = require('fs');
const path = require('path');

// SOLANA_STANDARD_PATH — the derivation path used by Phantom/Solflare/Backpack (m/44'/501'/0'/0').
// Wallets created here import into those apps with their 12-word phrase.
const SOLANA_STANDARD_PATH = "m/44'/501'/0'/0'";

function keypairFromPhrase(phrase) {
  const seed = Buffer.from(mnemonicToSeedSync(phrase, wordlist)).toString('hex');
  const { key } = derivePath(SOLANA_STANDARD_PATH, seed);
  return Keypair.fromSeed(Buffer.from(key));
}

const WALLET_DIR = process.env.BIG_WALLET_DIR || '/workspace/bigchain/wallets';

function walletPath(pubB58) { return path.join(WALLET_DIR, pubB58 + '.json'); }

function walletExists(pubB58) { return fs.existsSync(walletPath(pubB58)); }

function loadKeypair(pubB58) {
  const raw = JSON.parse(fs.readFileSync(walletPath(pubB58), 'utf8'));
  return Keypair.fromSecretKey(Buffer.from(raw.secret));
}

async function airdropFees(conn, dest, lamports) {
  try { await conn.requestAirdrop(dest, lamports || LAMPORTS_PER_SOL); } catch (e) { /* best-effort */ }
}

async function ensureATA(conn, MINT, payer, owner) {
  const ata = await splToken.getAssociatedTokenAddress(MINT, owner);
  const info = await conn.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      splToken.createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, MINT)
    );
    await sendAndConfirmTransaction(conn, tx, [payer]);
  }
  return ata;
}

// POST /wallet/create — make a new custodial BIG wallet: BIP39 seed phrase -> standard Solana
// derivation -> keypair. Phrase + secret live on the volume (mode 600); the phrase is returned
// once at creation and re-revealable via /wallet/phrase for the wallet owner.
async function createWallet(conn, MINT, TREASURY) {
  const phrase = generateMnemonic(wordlist, 128); // 12 words
  const kp = keypairFromPhrase(phrase);
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(walletPath(kp.publicKey.toBase58()), JSON.stringify({ secret: Array.from(kp.secretKey), phrase }, null, 0), { mode: 0o600 });
  await airdropFees(conn, kp.publicKey);
  await ensureATA(conn, MINT, kp, kp.publicKey); // wallet pays its own ATA rent
  return { address: kp.publicKey.toBase58(), phrase };
}

// GET /wallet/phrase?address= — reveal the dedicated seed phrase of a custodial wallet.
// Legacy wallets created before phrases have none (returns null) — their raw key still works.
function revealPhrase(pubB58) {
  if (!walletExists(pubB58)) throw new Error('Not a custodial BIG network wallet.');
  const raw = JSON.parse(fs.readFileSync(walletPath(pubB58), 'utf8'));
  return raw.phrase || null;
}

// GET /wallet/balance?address=... — SOL + $BIG for any chain address.
async function balances(conn, MINT, address) {
  const pub = new PublicKey(address);
  const sol = await conn.getBalance(pub, 'confirmed');
  const accs = await conn._rpcRequest('getTokenAccountsByOwner', [pub.toBase58(), { mint: MINT.toBase58() }, { encoding: 'jsonParsed' }]);
  let big = 0;
  (accs.value || []).forEach(a => { big += Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0); });
  return { address: pub.toBase58(), sol: sol / LAMPORTS_PER_SOL, big, custodial: walletExists(pub.toBase58()) };
}

// POST /wallet/send { from, to, amount } — move $BIG between addresses.
// from must be a custodial wallet we hold; to can be any address (ATA created if missing).
async function sendBig(conn, MINT, fromB58, toB58, amount) {
  if (!walletExists(fromB58)) throw new Error('Sender is not a BIG network wallet.');
  const from = loadKeypair(fromB58);
  if (from.publicKey.toBase58() !== fromB58) throw new Error('Wallet key mismatch — refusing.');
  const to = new PublicKey(toB58);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Amount must be a positive number.');
  await ensureATA(conn, MINT, from, to);
  const fromATA = await splToken.getAssociatedTokenAddress(MINT, from.publicKey);
  const toATA = await splToken.getAssociatedTokenAddress(MINT, to);
  const sig = await splToken.transfer(conn, from, fromATA, toATA, from.publicKey, BigInt(Math.round(amt * 1e9)), [], undefined, splToken.TOKEN_PROGRAM_ID);
  return sig;
}

// GET /wallet/list — roster of custodial wallets (public keys only).
function listWallets() {
  if (!fs.existsSync(WALLET_DIR)) return [];
  return fs.readdirSync(WALLET_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
}

module.exports = { createWallet, balances, sendBig, listWallets, walletExists, revealPhrase };
