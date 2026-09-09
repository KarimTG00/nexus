/**
 * Transaction Helius → swaps normalisés.
 *
 * ⚠️ PIÈGE CENTRAL : un swap agrégé (Jupiter, 1inch…) route à travers plusieurs
 * pools. Une transaction observée portait 12 `tokenTransfers` alors que
 * l'utilisateur n'avait échangé que deux actifs — les autres étaient des sauts
 * de routage entre comptes intermédiaires.
 *
 * Compter les `tokenTransfers` bruts fabriquerait donc des acheteurs qui
 * n'existent pas, et empoisonnerait `positions` — donc M2 (wallets alpha) et
 * M3 (initiés), qui reposent entièrement dessus.
 *
 * On lit `events.swap`, filtré sur le `feePayer` :
 *   présent dans tokenOutputs → l'utilisateur a REÇU le token  → achat
 *   présent dans tokenInputs  → l'utilisateur a DONNÉ le token → vente
 *
 * Repli sur le flux net des `tokenTransfers` du feePayer quand `events.swap`
 * est absent (certains DEX ne sont pas décodés).
 */

import { mod } from '../core/logger.js'

const log = mod('collector:parse')

/**
 * @typedef {Object} Swap
 * @property {string} wallet      l'utilisateur réel (feePayer)
 * @property {string} mint
 * @property {'buy'|'sell'} side
 * @property {number} amount      en unités du token
 * @property {number} ts          epoch ms
 * @property {string} signature
 * @property {string} source      JUPITER, RAYDIUM…
 */

const raw = t => {
  const a = t?.rawTokenAmount
  if (!a) return null
  const n = Number(a.tokenAmount)
  if (!Number.isFinite(n)) return null
  return n / 10 ** (a.decimals ?? 0)
}

/**
 * @param {Object} tx           transaction Helius enrichie
 * @param {Set<string>} mints   mints qui nous intéressent ; vide = tous
 * @returns {Swap[]}
 */
export function parseTransaction(tx, mints = null) {
  if (!tx || tx.transactionError) return []
  const wallet = tx.feePayer
  if (!wallet) return []

  const ts = (tx.timestamp ?? 0) * 1000
  const meta = { wallet, ts, signature: tx.signature, source: tx.source ?? null }
  const keep = m => !mints || mints.has(m)

  const swap = tx.events?.swap
  if (swap) {
    const out = []

    // Reçus par l'utilisateur → achat
    for (const o of swap.tokenOutputs ?? []) {
      if (o.userAccount !== wallet || !keep(o.mint)) continue
      const amount = raw(o)
      if (amount > 0) out.push({ ...meta, mint: o.mint, side: 'buy', amount })
    }

    // Donnés par l'utilisateur → vente
    for (const i of swap.tokenInputs ?? []) {
      if (i.userAccount !== wallet || !keep(i.mint)) continue
      const amount = raw(i)
      if (amount > 0) out.push({ ...meta, mint: i.mint, side: 'sell', amount })
    }

    if (out.length) return out
    // events.swap présent mais sans mouvement attribuable au feePayer
    // (le token qui nous intéresse n'était qu'un saut de routage) → rien.
    if ((swap.tokenInputs?.length ?? 0) + (swap.tokenOutputs?.length ?? 0) > 0) return []
  }

  return parseFromTransfers(tx, wallet, meta, keep)
}

/**
 * Repli : flux NET par mint pour le feePayer uniquement.
 * Le net est indispensable — un wallet peut apparaître des deux côtés d'un
 * même mint dans une transaction routée.
 */
function parseFromTransfers(tx, wallet, meta, keep) {
  const net = new Map()

  for (const t of tx.tokenTransfers ?? []) {
    const amount = Number(t.tokenAmount)
    if (!t.mint || !Number.isFinite(amount) || amount === 0 || !keep(t.mint)) continue
    if (t.toUserAccount === wallet) net.set(t.mint, (net.get(t.mint) ?? 0) + amount)
    else if (t.fromUserAccount === wallet) net.set(t.mint, (net.get(t.mint) ?? 0) - amount)
  }

  const out = []
  for (const [mint, delta] of net) {
    if (delta === 0) continue
    out.push({ ...meta, mint, side: delta > 0 ? 'buy' : 'sell', amount: Math.abs(delta) })
  }
  return out
}

/** Plusieurs transactions d'un coup (charge utile de webhook). */
export function parseBatch(txs, mints = null) {
  const out = []
  for (const tx of txs ?? []) {
    try {
      out.push(...parseTransaction(tx, mints))
    } catch (e) {
      log.warn({ signature: tx?.signature, err: e.message }, 'transaction illisible')
    }
  }
  return out
}
