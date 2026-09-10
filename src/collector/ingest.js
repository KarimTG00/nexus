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

// ---------------------------------------------------------------------------
// File d'attente — le seul chemin par lequel le webhook doit passer
// ---------------------------------------------------------------------------

/**
 * Helius pousse UNE transaction par appel, en rafale. Le serveur répondait 200
 * puis lançait `ingest()` sans attendre, sans file ni limite de concurrence :
 * chaque transaction devenait deux allers-retours Redis, une lecture Mongo et
 * une écriture, tous en parallèle. Mesuré en production : 2 529 positions en
 * une minute au pic, soit ~42 par seconde. Le pool Mongo (20 connexions)
 * sature, les promesses en vol s'accumulent, la mémoire monte, le conteneur
 * meurt — c'est ce qui a tué le service web à 03:41.
 *
 * On accumule donc, et on traite par lots : une centaine de transactions
 * deviennent un seul `bulkWrite`, avec au plus un lot en cours à la fois.
 */
const LOT_MAX = 500          // transactions par lot
const DELAI_MS = 500         // latence acceptée avant de vider la file
const FILE_MAX = 50_000      // au-delà, on préfère perdre que mourir

let file = []
let minuteur = null
let enCours = false
let perdus = 0
let dernierRapport = 0
const cumul = { lots: 0, transactions: 0, swaps: 0, positions: 0, doublons: 0, ignores: 0 }

/** Point d'entrée du webhook : accumule et rend la main immédiatement. */
export function enqueue(transactions, { chain = 'solana' } = {}) {
  if (!transactions?.length) return { queued: 0, pending: file.length }

  for (const tx of transactions) {
    if (file.length >= FILE_MAX) {
      // Borne dure. Perdre les plus anciennes est regrettable, mais un arrêt
      // par épuisement mémoire perd TOUT le flux pendant le redémarrage, plus
      // ce que Helius pousse entre-temps.
      file.shift()
      perdus++
    }
    file.push(tx)
  }

  if (!minuteur && !enCours) minuteur = setTimeout(() => vider(chain), DELAI_MS)
  else if (file.length >= LOT_MAX && !enCours) { clearTimeout(minuteur); minuteur = null; vider(chain) }

  return { queued: transactions.length, pending: file.length }
}

async function vider(chain) {
  minuteur = null
  if (enCours || !file.length) return
  enCours = true

  try {
    while (file.length) {
      const lot = file.splice(0, LOT_MAX)
      try {
        const s = await ingest(lot, { chain })
        cumul.lots++
        cumul.transactions += s.transactions
        cumul.swaps += s.swaps
        cumul.positions += s.positions
        cumul.doublons += s.doublons
        cumul.ignores += s.ignores
      } catch (e) {
        log.error({ err: e.message, lot: lot.length }, 'lot en échec')
      }
    }
  } finally {
    enCours = false
  }

  // Un journal par transaction produisait des milliers de lignes par minute,
  // illisibles et coûteuses. Un résumé toutes les 30 s dit la même chose.
  if (Date.now() - dernierRapport > 30_000) {
    dernierRapport = Date.now()
    log.info({ ...cumul, enAttente: file.length, perdus }, 'ingestion')
    for (const k of Object.keys(cumul)) cumul[k] = 0
  }

  if (file.length && !minuteur) minuteur = setTimeout(() => vider(chain), DELAI_MS)
}

/** État de la file, pour la sonde. */
export function queueStats() {
  return { pending: file.length, running: enCours, dropped: perdus }
}

/** Vérifie la signature partagée d'un webhook Helius. */
export function verifyWebhook(headers, secret) {
  if (!secret) return true                       // aucun secret configuré
  const auth = headers?.authorization ?? headers?.Authorization
  return auth === secret
}
