/**
 * `trigger_snapshots` — la collection la plus précieuse du système.
 *
 * Registre APPEND-ONLY IRREMPLAÇABLE : le contexte figé de chaque décision.
 * Aucune migration destructive n'y est autorisée, jamais. Le marché ne se
 * rejoue pas ; ce qu'on n'écrit pas ici est perdu définitivement.
 *
 * On y stocke la VALEUR MESURÉE de chaque filtre, pas seulement un booléen —
 * c'est ce qui rendra possible le balayage de seuil de M5 sans recollecter.
 */

import { col } from '../core/db/client.js'
import { SCHEMA_VERSION } from '../core/db/schema.js'
import { mod } from '../core/logger.js'

const log = mod('repo:triggers')

/** Verrou : un token ne déclenche qu'une fois par seuil. */
export const triggerId = (tokenId, threshold) => `${tokenId}:${threshold}`

/** Seuils déjà franchis par ces tokens (une requête, pas N). */
export async function existingTriggers(tokenIds) {
  if (!tokenIds.length) return new Set()
  const docs = await col('trigger_snapshots')
    .find({ token: { $in: tokenIds } }, { projection: { _id: 1 } })
    .toArray()
  return new Set(docs.map(d => d._id))
}

/**
 * Écrit le snapshot. Le verrou repose sur l'unicité de `_id` : deux cycles
 * concurrents ne peuvent pas déclencher deux fois le même palier.
 */
export async function record(snapshot) {
  const doc = {
    _id: triggerId(snapshot.token, snapshot.threshold),
    schema_version: SCHEMA_VERSION,
    ...snapshot,
    ts: snapshot.ts ?? new Date()
  }
  try {
    await col('trigger_snapshots').insertOne(doc)
    return doc
  } catch (e) {
    if (e.code === 11000) return null   // déjà déclenché : comportement voulu
    throw e
  }
}

/** Historise le franchissement sur le token lui-même. */
export async function appendToToken(tokenId, { threshold, decision, score, at }) {
  await col('tokens').updateOne({ _id: tokenId }, {
    $push: { triggers: { threshold, at: at ?? new Date(), decision, score } },
    $set: {
      status: decision === 'alerted' ? 'alerted' : 'quarantine',
      last_trigger_at: at ?? new Date()
    }
  })
}

/** Dernier snapshot d'un token, tous seuils confondus. */
export async function latestFor(tokenId) {
  return col('trigger_snapshots').find({ token: tokenId }).sort({ ts: -1 }).limit(1).next()
}

export async function countByDecision({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400_000)
  const rows = await col('trigger_snapshots').aggregate([
    { $match: { ts: { $gte: since } } },
    { $group: { _id: '$decision', n: { $sum: 1 } } }
  ]).toArray()
  return Object.fromEntries(rows.map(r => [r._id, r.n]))
}

/** Taux de rejet par filtre — alimente l'ordre d'exécution (M5). */
export async function rejectionRates({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400_000)
  const rows = await col('trigger_snapshots').aggregate([
    { $match: { ts: { $gte: since } } },
    { $unwind: '$filters' },
    { $group: {
        _id: '$filters.name',
        total: { $sum: 1 },
        failed: { $sum: { $cond: [{ $eq: ['$filters.passed', false] }, 1, 0] } }
    } }
  ]).toArray()

  return Object.fromEntries(rows.map(r => [r._id, r.total ? r.failed / r.total : 0]))
}
