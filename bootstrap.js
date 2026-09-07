// BIG Chain testnet bootstrap: treasury wallet + $BIG mint + genesis supply
const {
  Connection, Keypair, LAMPORTS_PER_SOL, clusterApiUrl, Transaction, SystemProgram, sendAndConfirmTransaction
} = require('@solana/web3.js');
const { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');

const RPC = 'http://127.0.0.1:8899';

async function main() {
  const conn = new Connection(RPC, 'confirmed');

  // 1) treasury wallet
  let treasury;
  if (fs.existsSync('treasury.key')) {
    treasury = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync('treasury.key'))));
    console.log('TREASURY (existing):', treasury.publicKey.toBase58());
  } else {
    treasury = Keypair.generate();
    fs.writeFileSync('treasury.key', JSON.stringify(Array.from(treasury.secretKey)));
    console.log('TREASURY (new):', treasury.publicKey.toBase58());
  }

  // 2) fund treasury with devnet SOL (retry loop)
  let bal = await conn.getBalance(treasury.publicKey);
  for (let i = 0; bal < LAMPORTS_PER_SOL * 0.05 && i < 6; i++) {
    try {
      const sig = await conn.requestAirdrop(treasury.publicKey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    } catch (e) { console.log('airdrop retry', i, e.message.slice(0, 80)); }
    await new Promise(r => setTimeout(r, 4000));
    bal = await conn.getBalance(treasury.publicKey);
  }
  console.log('TREASURY SOL:', bal / LAMPORTS_PER_SOL);

  // 3) $BIG mint (classic SPL for max wallet compatibility)
  let mintPub;
  if (fs.existsSync('mint.key')) {
    const km = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync('mint.key'))));
    mintPub = km.publicKey;
    console.log('MINT (existing):', mintPub.toBase58());
  } else {
    const mint = Keypair.generate();
    fs.writeFileSync('mint.key', JSON.stringify(Array.from(mint.secretKey)));
    const mintPk = await createMint(conn, treasury, treasury.publicKey, treasury.publicKey, 9, mint);
    mintPub = mintPk;
    console.log('MINT (new):', mintPub.toBase58());
  }

  // 4) genesis supply -> treasury ATA: 404,000,000 BIG
  const ata = await getOrCreateAssociatedTokenAccount(conn, treasury, mintPub, treasury.publicKey);
  const want = 404_000_000 * 1e9;
  const cur = Number(ata.amount);
  if (cur < want) {
    const sig = await mintTo(conn, treasury, mintPub, ata.address, treasury.publicKey, BigInt(want - cur));
    console.log('GENESIS MINTED:', sig);
  } else {
    console.log('GENESIS ALREADY MINTED:', cur / 1e9, 'BIG');
  }
  const ata2 = await getOrCreateAssociatedTokenAccount(conn, treasury, mintPub, treasury.publicKey);
  console.log('TREASURY BALANCE:', Number(ata2.amount) / 1e9, 'BIG');

  fs.writeFileSync('chain.json', JSON.stringify({
    network: 'solana-devnet', rpc: RPC,
    treasury: treasury.publicKey.toBase58(),
    mint: mintPub.toBase58(), decimals: 9, symbol: 'BIG',
    name: 'BIG Chain', supply: 404000000
  }, null, 2));
  console.log('bootstrap complete');
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
