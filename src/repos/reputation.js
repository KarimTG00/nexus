/**
 * Lectures de réputation — alimentées par la face 2 (M3, M4).
 * Tant que ces modules n'ont pas tourné, les collections sont vides :
 * les filtres correspondants se déclarent `skipped`, jamais « validé ».
 */

import { col } from '../core/db/client.js'

/** Réputation de plusieurs déployeurs en une requête. */
export async function deployerReputations(addresses) {
  const list = [...new Set(addresses.filter(Boolean))]
  if (!list.length) return new Map()

  const docs = await col('deployers').find({ address: { $in: list } }).toArray()
  const byAddr = new Map(docs.map(d => [d.address, d]))

  // Un déployeur peut être propre mais appartenir à un cluster blacklisté
  const clusterIds = [...new Set(docs.map(d => d.cluster_id).filter(Boolean))]
  if (clusterIds.length) {
    const clusters = await col('clusters')
      .find({ _id: { $in: clusterIds }, blacklisted: true }).toArray()
    const blacklisted = new Set(clusters.map(c => c._id))
    for (const d of docs) {
      if (d.cluster_id && blacklisted.has(d.cluster_id)) {
        d.blacklisted = true
        d.blacklist_reason ??= `cluster ${d.cluster_id}`
      }
    }
  }

  return byAddr
}

/**
 * Nombre de wallets toxiques parmi les premiers acheteurs d'un token.
 * Renvoie `null` tant que le collecteur de swaps (P7) n'a pas de données —
 * `null` signifie « non mesurable », pas « aucun ».
 */
export async function toxicBuyerCounts(tokenIds) {
  const anyToxic = await col('wallets').countDocuments({ 'toxic.flagged': true }, { limit: 1 })
  if (!anyToxic) return new Map(tokenIds.map(id => [id, null]))

  const rows = await col('positions').aggregate([
    { $match: { token: { $in: tokenIds } } },
    { $sort: { first_buy_ts: 1 } },
    { $group: { _id: '$token', wallets: { $push: '$wallet' } } },
    { $project: { wallets: { $slice: ['$wallets', 50] } } },
    { $lookup: {
        from: 'wallets', localField: 'wallets', foreignField: 'address',
        pipeline: [{ $match: { 'toxic.flagged': true } }], as: 'toxic' } },
    { $project: { count: { $size: '$toxic' } } }
  ]).toArray()

  const map = new Map(tokenIds.map(id => [id, 0]))
  for (const r of rows) map.set(r._id, r.count)
  return map
}
