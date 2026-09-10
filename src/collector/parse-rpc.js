/**
 * Transaction Solana BRUTE (RPC standard) → swaps normalisés.
 *
 * Pendant de `parse.js`, qui lit le format enrichi de Helius. Ici on n'a que
 * ce que tout nœud Solana expose : ni `feePayer`, ni `tokenTransfers`, ni
 * `events.swap` — ce sont des champs propres à Helius. C'est ce qui rend
 * n'importe quel fournisseur (Ankr, Alchemy, QuickNode, un nœud à soi)
 * interchangeable.
 *
 * MÉTHODE : la variation de SOLDE, pas les transferts.
 *
 * `meta.preTokenBalances` / `postTokenBalances` donnent, pour chaque couple
 * (propriétaire, mint), le solde avant et après. Leur différence est le flux
 * net réel de l'utilisateur.
 *
 * C'est plus sûr que de compter des transferts. Le piège central documenté
 * dans `parse.js` — une transaction Jupiter portant 12 transferts pour un
 * échange à 2 actifs — n'existe pas ici : un saut de routage déplace des
 * soldes de comptes de pools intermédiaires, jamais celui du payeur de frais.
 * Le filtre n'est plus une précaution, il est intrinsèque à la mesure.
 *
 * Vérifié contre le format Helius sur la même transaction : même wallet, même
 * montant (538 534,31587 achetés), même côté.
 */

import { mod } from '../core/logger.js'

const log = mod('collector:parse-rpc')

/** Le SOL natif et ses emballages : jamais le token qu'on suit. */
const SOL = 'So11111111111111111111111111111111111111112'

/** Stablecoins usuels — côté « monnaie » d'un swap, pas côté actif. */
const MONNAIES = new Set([
  SOL,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'    // USDT
])

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Le payeur de frais, c'est-à-dire l'utilisateur réel.
 * `accountKeys` est soit une liste d'objets (`jsonParsed`), soit de chaînes.
 */
function payeur(tx) {
  const k = tx?.transaction?.message?.accountKeys?.[0]
  if (!k) return null
  return typeof k === 'string' ? k : (k.pubkey ?? null)
}

/**
 * Variations de solde par (propriétaire, mint).
 * @returns {Map<string, {owner, mint, delta, decimals}>}
 */
export function deltasDeSolde(tx) {
  const out = new Map()
  const cle = (o, m) => `${o}|${m}`

  for (const b of tx?.meta?.preTokenBalances ?? []) {
    if (!b.owner || !b.mint) continue
    out.set(cle(b.owner, b.mint), {
      owner: b.owner, mint: b.mint,
      delta: -num(b.uiTokenAmount?.uiAmount),
      decimals: b.uiTokenAmount?.decimals ?? 0
    })
  }

  for (const b of tx?.meta?.postTokenBalances ?? []) {
    if (!b.owner || !b.mint) continue
    const k = cle(b.owner, b.mint)
    const e = out.get(k)
    if (e) e.delta += num(b.uiTokenAmount?.uiAmount)
    else out.set(k, {
      owner: b.owner, mint: b.mint,
      delta: num(b.uiTokenAmount?.uiAmount),
      decimals: b.uiTokenAmount?.decimals ?? 0
    })
  }

  return out
}

/**
 * @param {Object} tx           transaction brute (`getTransaction`, jsonParsed)
 * @param {Set<string>} mints   mints qui nous intéressent ; null = tous
 * @returns {Array} swaps au format attendu par `positions`
 */
export function parseTransactionRpc(tx, mints = null) {
  if (!tx || tx.meta?.err) return []

  const wallet = payeur(tx)
  if (!wallet) return []

  const ts = (tx.blockTime ?? 0) * 1000
  const signature = tx.transaction?.signatures?.[0] ?? tx.signature ?? null
  const keep = m => !mints || mints.has(m)

  const out = []
  for (const e of deltasDeSolde(tx).values()) {
    if (e.owner !== wallet) continue          // seuls les mouvements de l'utilisateur
    if (MONNAIES.has(e.mint)) continue        // la contrepartie, pas l'actif suivi
    if (!keep(e.mint)) continue

    // Un solde peut bouger d'une poussière à cause des frais ou d'un arrondi :
    // on ne fabrique pas un swap pour ça.
    if (Math.abs(e.delta) < 1e-9) continue

    out.push({
      wallet,
      mint: e.mint,
      side: e.delta > 0 ? 'buy' : 'sell',
      amount: Math.abs(e.delta),
      ts,
      signature,
      source: 'rpc'
    })
  }

  return out
}

/** Lot de transactions brutes → swaps. */
export function parseBatchRpc(transactions, mints = null) {
  const out = []
  for (const tx of transactions ?? []) {
    try {
      out.push(...parseTransactionRpc(tx, mints))
    } catch (e) {
      log.warn({ err: e.message }, 'transaction illisible')
    }
  }
  return out
}
