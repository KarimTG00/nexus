/**
 * Écriture des séries temporelles — collections time-series MongoDB.
 *
 * Un document par token et par tranche de 5 min, uniquement si le token a
 * été mesuré. ~150 octets, TTL 7 jours, puis agrégation horaire (P9).
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('repo:metrics')

/**
 * Insère un lot de points de mesure.
 * Les time-series n'acceptent pas d'update : chaque point est un insert.
 */
export async function writeSnapshots(points) {
  if (!points.length) return 0
  const docs = points.map(p => ({
    ts: p.ts ?? new Date(),
    meta: { token: p.token, chain: p.chain },

    // marché
    price: p.price ?? null,
    mc: p.mc ?? null,
    liquidity_usd: p.liquidityUsd ?? null,
    volume_24h: p.volume24h ?? null,

    // vélocité — null quand la source ne la fournit pas (jamais 0 par défaut)
    new_entrants: p.newEntrants ?? null,
    exits: p.exits ?? null,
    score: p.score ?? null,
    buys: p.buys ?? null,
    sells: p.sells ?? null,
    trades: p.trades ?? null,
    unique_traders: p.uniqueTraders ?? null,
    holders: p.holders ?? null
  }))

  try {
    await col('token_metrics').insertMany(docs, { ordered: false })
    return docs.length
  } catch (e) {
    log.warn({ err: e.message, n: docs.length }, 'écriture de métriques partielle')
    return 0
  }
}

/** Derniers points d'un token, du plus récent au plus ancien. */
export async function recentSnapshots(tokenId, limit = 12) {
  return col('token_metrics')
    .find({ 'meta.token': tokenId })
    .sort({ ts: -1 })
    .limit(limit)
    .toArray()
}

/**
 * Construit un point de mesure à partir de ce qu'on a sous la main.
 * `market` vient du lot (multi-data), `velocity` du rafraîchissement Pulse.
 */
export function buildPoint(token, market, velocity) {
  const w = velocity?.['5min'] ?? {}
  const buyers = w.buyers ?? null
  const sellers = w.sellers ?? null

  return {
    token: token._id,
    chain: token.chain,
    ts: new Date(),
    price: market?.price ?? token.market?.price ?? null,
    mc: market?.mc ?? token.market?.mc ?? null,
    liquidityUsd: market?.liquidityUsd ?? token.market?.liquidity_usd ?? null,
    volume24h: market?.volume24h ?? token.market?.volume_24h ?? null,

    // Le score d'intérêt : acheteurs uniques moins vendeurs uniques.
    // Reste null si la source ne distingue pas les wallets — on ne fabrique
    // pas un score à partir de comptes de transactions.
    newEntrants: buyers,
    exits: sellers,
    score: buyers !== null && sellers !== null ? buyers - sellers : null,
    buys: w.buys ?? null,
    sells: w.sells ?? null,
    trades: w.trades ?? null,
    uniqueTraders: w.traders ?? null,
    holders: token.holders?.count ?? null
  }
}
