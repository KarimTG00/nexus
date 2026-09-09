/**
 * `positions` — une ligne par couple wallet × token.
 *
 * C'est le CHEMIN D'ÉCRITURE LE PLUS CHAUD du système : ~1,5 M de mises à jour
 * par jour à pleine charge. Un wallet qui fait 40 swaps sur un token produit
 * UN document, pas 40.
 *
 * L'`_id` est composite (`chain:token:wallet`) précisément pour que l'upsert
 * se fasse par clé primaire, sans parcours d'index. Mesuré ailleurs dans ce
 * projet : une écriture unitaire coûte ~300 ms sur Atlas M0, un bulkWrite est
 * 21× plus rapide — donc tout passe en lot.
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('repo:positions')

/** `tokenId` contient déjà la chaîne (`solana:ABC…`) — ne pas la préfixer deux fois. */
export const positionId = (tokenId, wallet) => `${tokenId}:${wallet}`

/**
 * Construit l'opération d'upsert d'un swap.
 *
 * Tout est incrémental : aucune lecture préalable, aucune relecture
 * d'historique. C'est ce qui permet de tenir le débit — et c'est la règle
 * d'architecture « toute métrique doit être calculable en O(1) à l'arrivée
 * d'un événement ».
 */
export function buildSwapOp(swap, { chain, tokenId, mcAtEntry = null }) {
  const _id = positionId(tokenId, swap.wallet)
  const ts = new Date(swap.ts)
  const usd = swap.amountUsd ?? null

  const inc = {}
  if (swap.side === 'buy') {
    inc.bought_amount = swap.amount
    inc.buy_count = 1
    if (usd !== null) inc.bought_usd = usd
  } else {
    inc.sold_amount = swap.amount
    inc.sell_count = 1
    if (usd !== null) inc.sold_usd = usd
  }

  return {
    updateOne: {
      filter: { _id },
      update: {
        $inc: inc,
        $set: { last_activity_ts: ts },
        $max: { last_seen_ts: ts },
        $setOnInsert: {
          wallet: swap.wallet,
          token: tokenId,
          chain,
          first_buy_ts: ts,
          first_buy_mc: mcAtEntry,
          first_side: swap.side,
          closed: false
        }
      },
      upsert: true
    }
  }
}

export async function bulkApply(ops) {
  if (!ops.length) return { matched: 0, upserted: 0 }
  const r = await col('positions').bulkWrite(ops, { ordered: false })
  return { matched: r.modifiedCount ?? 0, upserted: r.upsertedCount ?? 0 }
}

/**
 * Clôture les positions soldées : ≥ 90 % de la quantité achetée revendue.
 *
 * Une position ouverte n'a rien prouvé — c'est pourquoi M2 ne classe un wallet
 * que sur ses positions FERMÉES. Le PnL réalisé se calcule ici, une fois.
 */
export async function closeSettled({ ratio = 0.9, limit = 5000 } = {}) {
  const candidates = await col('positions').find({
    closed: false,
    sold_amount: { $gt: 0 }
  }, { projection: { bought_amount: 1, sold_amount: 1, bought_usd: 1, sold_usd: 1, last_activity_ts: 1 } })
    .limit(limit).toArray()

  const ops = []
  for (const p of candidates) {
    const bought = p.bought_amount ?? 0
    if (bought <= 0 || (p.sold_amount ?? 0) < bought * ratio) continue

    const inUsd = p.bought_usd ?? null
    const outUsd = p.sold_usd ?? null
    const pnl = inUsd !== null && outUsd !== null ? outUsd - inUsd : null

    ops.push({
      updateOne: {
        filter: { _id: p._id },
        update: {
          $set: {
            closed: true,
            closed_at: p.last_activity_ts ?? new Date(),
            realized_pnl_usd: pnl,
            realized_pnl_pct: pnl !== null && inUsd > 0 ? +((pnl / inUsd) * 100).toFixed(2) : null
          }
        }
      }
    })
  }

  if (!ops.length) return 0
  const r = await col('positions').bulkWrite(ops, { ordered: false })
  log.info({ closes: r.modifiedCount }, 'positions clôturées')
  return r.modifiedCount ?? 0
}

/** Les N premiers acheteurs d'un token — base de M3 (détection d'initiés). */
export async function earlyBuyers(tokenId, n = 100) {
  return col('positions')
    .find({ token: tokenId, first_side: 'buy' }, {
      projection: { wallet: 1, first_buy_ts: 1, first_buy_mc: 1, bought_usd: 1 } })
    .sort({ first_buy_ts: 1 }).limit(n).toArray()
}

export async function stats() {
  const [total, closed, wallets] = await Promise.all([
    col('positions').countDocuments(),
    col('positions').countDocuments({ closed: true }),
    col('positions').distinct('wallet').then(w => w.length).catch(() => null)
  ])
  return { total, closed, open: total - closed, wallets }
}

/**
 * Purge : positions closes, anciennes, petites, dont le wallet n'est pas
 * classé. Sans elle la collection croît sans fin (voir docs/data-model.md).
 */
export async function purge({ days = 90, minUsd = 50 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400_000)
  const classes = await col('wallets').distinct('address')
  const r = await col('positions').deleteMany({
    closed: true,
    closed_at: { $lt: cutoff },
    wallet: { $nin: classes },
    $or: [{ bought_usd: { $lt: minUsd } }, { bought_usd: null }]
  })
  return r.deletedCount
}
