/**
 * Surveillance des wallets ALPHA — ceux dont on veut vérifier, sur une durée
 * fixée (`watch_until`), s'ils gagnent vraiment et s'ils changent de wallet
 * pour agir.
 *
 * Deux sources complémentaires :
 *   - le flux pump.fun voit déjà chaque trade de ces wallets à la seconde :
 *     stream.js les écrit dans `wallet_alpha_trades` et garde la trajectoire
 *     complète des tokens concernés (trades et bougies) ;
 *   - ce module relève TOUTES leurs transactions sur la chaîne
 *     (getSignaturesForAddress puis getTransaction) : virements de SOL, autres
 *     DEX, financement de nouveaux wallets — tout ce que le flux ne voit pas.
 *
 * Un relevé plutôt qu'un abonnement WebSocket : un abonnement muet ne se
 * distingue pas d'un wallet inactif, alors qu'un relevé reprend exactement où
 * il s'était arrêté (`last_signature`), redémarrages compris.
 */

import { col } from '../../core/db/client.js'
import { mod } from '../../core/logger.js'

const log = mod('collector:alpha')

const LAMPORTS = 1e9
const PAGE = 100
// Premier relevé d'un wallet : son passé récent, pour voir d'où vient son SOL.
const HISTORIQUE_INITIAL = 300
// Un virement sortant au-dessus de ce montant désigne un wallet candidat :
// c'est ainsi qu'un groupe arme de nouveaux wallets avant d'en changer.
// En dessous, ce sont des pourboires et des frais.
const SEUIL_VIREMENT_SOL = 0.5
const PAUSE_MS = 200

let surveilles = new Map()
let rpc = null
let minuteurs = []
let enCours = false

export const statsAlpha = { cycles: 0, transactions: 0, echecs: 0, candidats: 0 }

export const estAlpha = wallet => surveilles.has(wallet)

/** Wallets à surveiller maintenant : rôle `surveille`, période non échue. */
export async function chargerAlpha() {
  const docs = await col('wallet_alpha').find({ role: 'surveille', watch_until: { $gt: new Date() } }).toArray()
  surveilles = new Map(docs.map(d => [d._id, d]))
  return surveilles.size
}

/**
 * Résumé d'une transaction du point de vue d'un wallet : variation de SOL,
 * virements système qui le concernent (instructions internes comprises),
 * variations de ses soldes de tokens, programmes appelés.
 */
export function resumerTransaction(tx, wallet) {
  const meta = tx?.meta
  const message = tx?.transaction?.message
  if (!meta || !message) return null

  const cles = (message.accountKeys ?? []).map(k => (typeof k === 'string' ? k : k.pubkey))
  const i = cles.indexOf(wallet)

  const instructions = [
    ...(message.instructions ?? []),
    ...(meta.innerInstructions ?? []).flatMap(x => x.instructions ?? [])
  ]
  const virements = instructions
    .filter(x => x.program === 'system' && ['transfer', 'transferWithSeed'].includes(x.parsed?.type))
    .map(x => ({ de: x.parsed.info.source, vers: x.parsed.info.destination, sol: x.parsed.info.lamports / LAMPORTS }))
    .filter(v => v.de === wallet || v.vers === wallet)

  // Un compte de token fermé dans la transaction n'a plus de solde « après » :
  // son absence vaut zéro, pas une inconnue.
  const soldes = new Map()
  for (const b of meta.preTokenBalances ?? []) {
    if (b.owner === wallet) soldes.set(b.mint, { avant: Number(b.uiTokenAmount?.uiAmount ?? 0), apres: 0 })
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.owner !== wallet) continue
    const s = soldes.get(b.mint) ?? { avant: 0, apres: 0 }
    s.apres = Number(b.uiTokenAmount?.uiAmount ?? 0)
    soldes.set(b.mint, s)
  }

  return {
    sol_delta: i >= 0 ? (meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS : null,
    sol_apres: i >= 0 ? meta.postBalances[i] / LAMPORTS : null,
    frais_sol: (meta.fee ?? 0) / LAMPORTS,
    echec: Boolean(meta.err),
    programmes: [...new Set((message.instructions ?? []).map(x => x.programId).filter(Boolean))],
    virements,
    tokens: [...soldes.entries()].map(([mint, s]) => ({ mint, delta: s.apres - s.avant })).filter(t => t.delta !== 0)
  }
}

/** Virements marquants : wallets armés par un wallet surveillé, et ses financeurs. */
async function noterVirements(wallet, doc) {
  for (const v of doc.virements ?? []) {
    if (v.sol < SEUIL_VIREMENT_SOL) continue
    const sortant = v.de === wallet
    const autre = sortant ? v.vers : v.de
    if (estAlpha(autre)) continue
    try {
      const r = await col('wallet_alpha').updateOne({ _id: autre }, {
        $setOnInsert: {
          role: sortant ? 'candidat' : 'financeur',
          added_at: new Date(),
          raison: sortant ? 'a reçu du SOL d\'un wallet surveillé' : 'a envoyé du SOL à un wallet surveillé'
        },
        $addToSet: { [sortant ? 'finance_par' : 'a_finance']: wallet },
        $inc: { sol: v.sol, virements: 1 },
        $set: { dernier_virement_at: doc.ts }
      }, { upsert: true })
      if (r.upsertedCount) statsAlpha.candidats++
    } catch (e) {
      if (e.code !== 11000) throw e
    }
  }
}

const pause = ms => new Promise(r => setTimeout(r, ms))

/** Relève les transactions d'un wallet depuis la dernière traitée. */
async function releverWallet(d) {
  const wallet = d._id
  const nouvelles = []
  let avant = null
  for (;;) {
    const opts = { limit: PAGE, commitment: 'confirmed' }
    if (d.last_signature) opts.until = d.last_signature
    if (avant) opts.before = avant
    const page = await rpc('getSignaturesForAddress', [wallet, opts])
    if (!page?.length) break
    nouvelles.push(...page)
    if (page.length < PAGE || (!d.last_signature && nouvelles.length >= HISTORIQUE_INITIAL)) break
    avant = page.at(-1).signature
  }
  if (!nouvelles.length) return 0

  // Du plus ancien au plus récent : `last_signature` n'avance que sur ce qui
  // est traité, et un échec au milieu reprend au cycle suivant sans trou.
  let traitees = 0
  for (const s of nouvelles.reverse()) {
    let tx
    try {
      tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
    } catch (e) {
      statsAlpha.echecs++
      log.warn({ wallet, err: e.message }, 'transaction alpha non lue — reprise au prochain relevé')
      break
    }
    const resume = resumerTransaction(tx, wallet)
    const doc = {
      _id: `${s.signature}:${wallet}`,
      signature: s.signature,
      wallet,
      slot: s.slot,
      ts: s.blockTime ? new Date(s.blockTime * 1000) : null,
      ...(resume ?? { illisible: true }),
      releve_le: new Date()
    }
    await col('wallet_alpha_activity').updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true })
    await noterVirements(wallet, doc)

    d.last_signature = s.signature
    const maj = { last_signature: s.signature, last_activity_at: doc.ts }
    if (resume?.sol_apres !== null && resume?.sol_apres !== undefined) maj.sol_balance = resume.sol_apres
    await col('wallet_alpha').updateOne({ _id: wallet }, { $set: maj })
    traitees++
    await pause(PAUSE_MS)
  }
  return traitees
}

async function cycle() {
  if (enCours || !rpc) return
  enCours = true
  try {
    await chargerAlpha()
    for (const d of surveilles.values()) {
      try {
        statsAlpha.transactions += await releverWallet(d)
      } catch (e) {
        statsAlpha.echecs++
        log.warn({ wallet: d._id, err: e.message }, 'relevé alpha en échec')
      }
    }
    statsAlpha.cycles++
  } finally {
    enCours = false
  }
}

/** Démarre le relevé ; `rpcHttp(method, params)` est l'appel RPC du flux. */
export async function demarrerAlpha({ rpcHttp, intervalleMs = 30_000 }) {
  rpc = rpcHttp
  const n = await chargerAlpha()
  minuteurs.push(setInterval(() => { cycle().catch(() => { /* journalisé dans cycle */ }) }, intervalleMs))
  cycle().catch(() => { /* journalisé dans cycle */ })
  log.info({ wallets: n }, 'surveillance des wallets alpha démarrée')
}

export function arreterAlpha() {
  for (const m of minuteurs) clearInterval(m)
  minuteurs = []
}
