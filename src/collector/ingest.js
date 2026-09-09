/**
 * Collecteur de swaps — le seul composant qui alimente `positions`.
 *
 * Sert EXCLUSIVEMENT la face 2 : M2 (wallets alpha), M3 (initiés) et M4
 * (chevauchement des early buyers) ont besoin de savoir QUELS wallets ont
 * acheté. Aucun agrégat ne le donne — la face 1 n'en a pas besoin depuis
 * qu'elle lit la vélocité chez Mobula.
 *
 * ⚠️ Il doit tourner en continu dès que possible, même si M2/M3 ne sont pas
 * encore écrits. Un flux qu'on n'écoutait pas ne se rattrape jamais : les
 * positions du mois dernier sont définitivement perdues. Même contrainte que
 * le suivi d'outcome.
 *
 * En collecteur pur, il fait UNE chose :
 *     swap reçu → upsert de la position → jeté
 */

import { parseBatch } from './parse.js'
import * as positionsRepo from '../repos/positions.js'
import { col } from '../core/db/client.js'
import { cache } from '../core/cache/index.js'
import { tokenId } from '../core/chains.js'
import { mod } from '../core/logger.js'

const log = mod('collector')

/** Cache des mints suivis — évite une requête Mongo par transaction. */
const WATCH_KEY = 'collector:watched:solana'
let watched = { set: new Set(), at: 0 }

export async function watchedMints({ ttlMs = 120_000, force = false } = {}) {
  if (!force && watched.set.size && Date.now() - watched.at < ttlMs) return watched.set

  const docs = await col('tokens').find(
    { chain: 'solana', status: { $in: ['pending_activity', 'tracked', 'triggered', 'alerted'] } },
    { projection: { address: 1 } }
  ).toArray()

  watched = { set: new Set(docs.map(d => d.address)), at: Date.now() }
  log.debug({ mints: watched.set.size }, 'liste de surveillance rafraîchie')
  return watched.set
}

/**
 * Traite une charge utile de transactions (webhook ou interrogation).
 * @returns {{ transactions, swaps, positions, ignores }}
 */
export async function ingest(transactions, { chain = 'solana' } = {}) {
  const stats = { transactions: transactions?.length ?? 0, swaps: 0, positions: 0, ignores: 0, doublons: 0 }
  if (!stats.transactions) return stats

  const mints = await watchedMints()
  const swaps = parseBatch(transactions, mints)
  stats.swaps = swaps.length
  stats.ignores = stats.transactions - new Set(swaps.map(s => s.signature)).size

  if (!swaps.length) return stats

  // Déduplication : un webhook peut renvoyer la même transaction (réessai
  // Helius, redémarrage). Sans ça, une position serait comptée deux fois.
  const nouveaux = []
  for (const s of swaps) {
    const key = `swap:${s.signature}:${s.mint}:${s.side}`
    const vu = await cache().get(key)
    if (vu) { stats.doublons++; continue }
    await cache().set(key, '1', 86_400)
    nouveaux.push(s)
  }
  if (!nouveaux.length) return stats

  // MC à l'entrée : la précocité de M2 en dépend entièrement.
  const ids = [...new Set(nouveaux.map(s => tokenId(chain, s.mint)))]
  const tokens = await col('tokens').find(
    { _id: { $in: ids } }, { projection: { 'market.mc': 1 } }).toArray()
  const mcById = new Map(tokens.map(t => [t._id, t.market?.mc ?? null]))

  const ops = nouveaux.map(s => positionsRepo.buildSwapOp(s, {
    chain,
    tokenId: tokenId(chain, s.mint),
    mcAtEntry: mcById.get(tokenId(chain, s.mint)) ?? null
  }))

  const r = await positionsRepo.bulkApply(ops)
  stats.positions = r.matched + r.upserted
  return stats
}

/** Vérifie la signature partagée d'un webhook Helius. */
export function verifyWebhook(headers, secret) {
  if (!secret) return true                       // aucun secret configuré
  const auth = headers?.authorization ?? headers?.Authorization
  return auth === secret
}
