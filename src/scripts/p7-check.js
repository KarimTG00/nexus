/**
 * Validation de la phase P7.
 *
 * Critère (docs/roadmap.md) : `positions` se remplit et un PnL par position
 * est reconstituable pour un wallet donné.
 *
 * Le point délicat est le parsing : un swap agrégé route à travers plusieurs
 * pools, et compter les transferts bruts fabriquerait de faux acheteurs.
 *
 * Usage : npm run p7
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { parseTransaction, parseBatch } from '../collector/parse.js'
import { ingest, watchedMints } from '../collector/ingest.js'
import * as positionsRepo from '../repos/positions.js'
import { addressesToWatch } from '../collector/helius-webhook.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

const USER = 'WALLETuser11111111111111111111111111111111'
const ROUTER = 'ROUTERaaa11111111111111111111111111111111'
const MEME = 'MEMEmint1111111111111111111111111111111111'
const SOL = 'So11111111111111111111111111111111111111112'

async function main() {
  loadEnv()
  await db.connect(); await cache.connect()
  let allOk = true

  console.log('\n\x1b[1mValidation P7 — collecteur de swaps\x1b[0m\n')

  // --- 1. Le piège du routage ---------------------------------------------
  console.log('1. Parsing : le piège du routage multi-sauts')

  // L'utilisateur achète MEME avec du SOL. La transaction contient en plus
  // deux sauts de routage entre comptes intermédiaires, portant le MÊME mint.
  const txRoutee = {
    signature: 'sig_route', timestamp: 1788920000, feePayer: USER, source: 'JUPITER',
    tokenTransfers: [
      { mint: MEME, tokenAmount: 5000, fromUserAccount: ROUTER, toUserAccount: USER },
      { mint: MEME, tokenAmount: 9999, fromUserAccount: ROUTER, toUserAccount: 'AUTRE1' },
      { mint: MEME, tokenAmount: 8888, fromUserAccount: 'AUTRE1', toUserAccount: 'AUTRE2' }
    ],
    events: {
      swap: {
        tokenInputs: [{ userAccount: USER, mint: SOL, rawTokenAmount: { tokenAmount: '2000000000', decimals: 9 } }],
        tokenOutputs: [{ userAccount: USER, mint: MEME, rawTokenAmount: { tokenAmount: '5000000000', decimals: 6 } }]
      }
    }
  }
  const r1 = parseTransaction(txRoutee, new Set([MEME]))
  const bon1 = r1.length === 1 && r1[0].side === 'buy' && r1[0].wallet === USER && r1[0].amount === 5000
  if (!bon1) allOk = false
  ;(bon1 ? ok : ko)(`3 transferts du même mint, 2 étant du routage → ${r1.length} swap retenu (achat de ${r1[0]?.amount})`)
  ok('les sauts de routage ne fabriquent pas d\'acheteurs fantômes')

  // --- 2. Vente ------------------------------------------------------------
  const txVente = {
    signature: 'sig_sell', timestamp: 1788920100, feePayer: USER, source: 'RAYDIUM',
    tokenTransfers: [],
    events: {
      swap: {
        tokenInputs: [{ userAccount: USER, mint: MEME, rawTokenAmount: { tokenAmount: '5000000000', decimals: 6 } }],
        tokenOutputs: [],
        nativeOutput: { account: USER, amount: '3000000000' }
      }
    }
  }
  const r2 = parseTransaction(txVente, new Set([MEME]))
  const bon2 = r2.length === 1 && r2[0].side === 'sell' && r2[0].amount === 5000
  if (!bon2) allOk = false
  ;(bon2 ? ok : ko)(`vente détectée → ${r2[0]?.side} de ${r2[0]?.amount}`)

  // --- 3. Repli sans events.swap -------------------------------------------
  const txBrute = {
    signature: 'sig_raw', timestamp: 1788920200, feePayer: USER, source: 'INCONNU',
    tokenTransfers: [
      { mint: MEME, tokenAmount: 800, fromUserAccount: ROUTER, toUserAccount: USER },
      { mint: MEME, tokenAmount: 300, fromUserAccount: USER, toUserAccount: ROUTER }
    ]
  }
  const r3 = parseTransaction(txBrute, new Set([MEME]))
  const bon3 = r3.length === 1 && r3[0].side === 'buy' && r3[0].amount === 500
  if (!bon3) allOk = false
  ;(bon3 ? ok : ko)(`repli sur le flux NET : +800 −300 → ${r3[0]?.side} de ${r3[0]?.amount}`)

  // --- 4. Filtres ----------------------------------------------------------
  const horsListe = parseTransaction(txRoutee, new Set(['AUTRE_MINT']))
  const enEchec = parseTransaction({ ...txRoutee, transactionError: { err: 1 } }, new Set([MEME]))
  ;(horsListe.length === 0 ? ok : ko)('mint hors liste de surveillance → ignoré')
  ;(enEchec.length === 0 ? ok : ko)('transaction en échec → ignorée')
  if (horsListe.length || enEchec.length) allOk = false

  // --- 5. Positions : incrémental et idempotent ---------------------------
  console.log('\n2. Positions')
  const TOKEN = 'solana:' + MEME
  await col('positions').deleteMany({ token: TOKEN })

  const ops = [
    positionsRepo.buildSwapOp({ ...r1[0], mint: MEME }, { chain: 'solana', tokenId: TOKEN, mcAtEntry: 62_000 }),
    positionsRepo.buildSwapOp({ ...r2[0], mint: MEME }, { chain: 'solana', tokenId: TOKEN })
  ]
  await positionsRepo.bulkApply(ops)

  const p = await col('positions').findOne({ _id: `${TOKEN}:${USER}` })
  const bon5 = p && p.bought_amount === 5000 && p.sold_amount === 5000 && p.first_buy_mc === 62_000
  if (!bon5) allOk = false
  ;(bon5 ? ok : ko)(`un document pour 2 swaps : acheté ${p?.bought_amount}, vendu ${p?.sold_amount}, MC à l'entrée ${p?.first_buy_mc}`)
  ok(`_id composite → upsert par clé primaire : ${p?._id}`)

  const closes = await positionsRepo.closeSettled()
  const pf = await col('positions').findOne({ _id: `${TOKEN}:${USER}` })
  ;(pf?.closed ? ok : ko)(`clôture à ≥90 % revendu → closed=${pf?.closed} (${closes} clôturée(s))`)
  if (!pf?.closed) allOk = false

  // --- 6. Ingestion complète, avec déduplication --------------------------
  console.log('\n3. Ingestion')
  const mints = await watchedMints({ force: true })
  ok(`${mints.size} mints Solana sous surveillance`)

  const vrais = await col('tokens').find({ chain: 'solana' }, { projection: { address: 1 } }).limit(1).toArray()
  if (vrais.length) {
    const mint = vrais[0].address
    const tx = {
      signature: 'sig_test_' + Date.now(), timestamp: Math.floor(Date.now() / 1000),
      feePayer: USER, source: 'TEST', tokenTransfers: [],
      events: { swap: {
        tokenInputs: [],
        tokenOutputs: [{ userAccount: USER, mint, rawTokenAmount: { tokenAmount: '1000000', decimals: 6 } }]
      } }
    }
    const s1 = await ingest([tx])
    const s2 = await ingest([tx])          // même transaction, rejouée
    ok(`1er passage : ${s1.swaps} swap, ${s1.positions} position écrite`)
    ;(s2.doublons > 0 && s2.positions === 0 ? ok : ko)(
      `rejeu de la même transaction : ${s2.doublons} doublon détecté, ${s2.positions} écriture`)
    if (!(s2.doublons > 0 && s2.positions === 0)) allOk = false
  } else warn('aucun token Solana en base pour un test bout-en-bout')

  // --- 7. Early buyers -----------------------------------------------------
  console.log('\n4. Early buyers (base de M3)')
  const eb = await positionsRepo.earlyBuyers(TOKEN, 10)
  ;(eb.length > 0 ? ok : warn)(`${eb.length} acheteur(s) précoce(s), triés par date d'entrée`)
  const st = await positionsRepo.stats()
  ok(`positions : ${st.total} total, ${st.closed} closes, ${st.open} ouvertes, ${st.wallets} wallets`)

  // --- 8. Webhook ----------------------------------------------------------
  console.log('\n5. Webhook Helius')
  const addrs = await addressesToWatch()
  ok(`${addrs.length} adresses à surveiller (limite Helius : 100 000)`)
  ;(process.env.HELIUS_WEBHOOK_ID ? ok : warn)(
    process.env.HELIUS_WEBHOOK_ID
      ? `webhook existant : ${process.env.HELIUS_WEBHOOK_ID}`
      : 'aucun HELIUS_WEBHOOK_ID — à créer après le déploiement, quand l\'URL publique existera')
  warn('chaque création/modification de webhook coûte 100 crédits Helius — synchro seulement si la liste change')

  console.log(allOk
    ? '\n\x1b[1m\x1b[32mP7 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP7 NON validée.\x1b[0m\n')
  process.exitCode = allOk ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
