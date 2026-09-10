/**
 * Journaux `Transfer` ERC-20 → swaps normalisés.
 *
 * Pendant EVM de `parse-rpc.js`. Même exigence de sortie, donc `positions`,
 * M2 et M3 ne voient aucune différence entre une chaîne et une autre.
 *
 * MÉTHODE : le flux NET par adresse, à l'échelle d'une transaction.
 *
 * Le piège de routage est plus sévère ici que sur Solana. Observé sur
 * Robinhood Chain, une seule transaction :
 *
 *     0x8366a39c -> 0xe5e70264      3 413,91     (frais)
 *     0x8366a39c -> 0x6aa80dbb    337 976,92
 *     0x6aa80dbb -> 0xb92fe925    337 976,92
 *     0xb92fe925 -> 0x593f6b3f    337 976,92
 *
 * Le même montant traverse trois adresses. Compter les transferts fabriquerait
 * quatre acheteurs pour un swap. Le flux net les élimine : un intermédiaire
 * reçoit puis réémet, son solde est nul. Ne subsistent que le pool (négatif)
 * et le destinataire final (positif).
 *
 * ⚠️ Reste à distinguer l'utilisateur de l'infrastructure. Un pool, un routeur
 * ou un collecteur de frais réapparaissent dans presque toutes les
 * transactions du token, là où un trader n'y figure qu'une fois. On s'appuie
 * d'abord sur les pools connus, puis sur cette récurrence — jamais sur la
 * seule taille du montant, qui désignerait le pool.
 */

import { mod } from '../core/logger.js'

const log = mod('collector:parse-evm')

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const ZERO = '0x0000000000000000000000000000000000000000'

/** Un topic indexé porte l'adresse sur ses 20 derniers octets. */
const adresse = topic => ('0x' + String(topic).slice(26)).toLowerCase()

const montant = data => {
  try { return BigInt(data ?? '0x0') } catch { return 0n }
}

/**
 * Regroupe des journaux par transaction.
 * @returns {Map<string, Array>}
 */
export function grouperParTransaction(logs) {
  const out = new Map()
  for (const l of logs ?? []) {
    if (l.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue
    if (l.removed) continue                      // réorganisation de chaîne
    const h = l.transactionHash
    if (!h) continue
    const a = out.get(h) ?? []
    a.push(l)
    out.set(h, a)
  }
  return out
}

/**
 * Adresses d'infrastructure : celles qui reviennent d'une transaction à
 * l'autre. Un trader n'apparaît qu'une fois ; un pool, un routeur ou un
 * collecteur de frais apparaissent partout.
 *
 * @param {Map} parTx           sortie de `grouperParTransaction`
 * @param {number} seuil        nombre de transactions distinctes à partir
 *                              duquel une adresse est jugée structurelle
 */
export function detecterInfrastructure(parTx, seuil = 2) {
  const compte = new Map()
  for (const logs of parTx.values()) {
    const vues = new Set()
    for (const l of logs) {
      vues.add(adresse(l.topics[1]))
      vues.add(adresse(l.topics[2]))
    }
    for (const a of vues) compte.set(a, (compte.get(a) ?? 0) + 1)
  }
  const out = new Set([ZERO])
  for (const [a, n] of compte) if (n >= seuil) out.add(a)
  return out
}

/**
 * Flux net par adresse, pour une transaction.
 * @returns {Map<string, bigint>}
 */
export function fluxNet(logs) {
  const net = new Map()
  const ajouter = (a, v) => net.set(a, (net.get(a) ?? 0n) + v)
  for (const l of logs) {
    const v = montant(l.data)
    if (v === 0n) continue
    ajouter(adresse(l.topics[1]), -v)
    ajouter(adresse(l.topics[2]), v)
  }
  for (const [a, v] of net) if (v === 0n) net.delete(a)   // intermédiaires
  return net
}

/**
 * @param {Array} logs            journaux Transfer d'UNE transaction, un seul token
 * @param {Object} ctx            { mint, decimals, ts, infrastructure:Set, pools:Set }
 * @returns {Array} swaps, au plus un par transaction
 */
export function parseTransactionEvm(logs, ctx = {}) {
  if (!logs?.length) return []

  const { mint, decimals = 18, ts = 0, infrastructure = new Set(), pools = new Set() } = ctx
  const net = fluxNet(logs)
  if (!net.size) return []

  // Candidats : ni pool connu, ni adresse structurelle, ni adresse nulle.
  const candidats = [...net.entries()]
    .filter(([a]) => a !== ZERO && !pools.has(a) && !infrastructure.has(a))

  if (!candidats.length) return []

  // Le plus gros mouvement restant est l'utilisateur. Filtrer AVANT de
  // comparer les montants est essentiel : le pool est toujours le plus gros.
  candidats.sort((x, y) => (y[1] < 0n ? -y[1] : y[1]) > (x[1] < 0n ? -x[1] : x[1]) ? 1 : -1)
  const [wallet, delta] = candidats[0]
  if (delta === 0n) return []

  const amount = Number(delta < 0n ? -delta : delta) / 10 ** decimals
  if (!Number.isFinite(amount) || amount <= 0) return []

  return [{
    wallet,
    mint,
    side: delta > 0n ? 'buy' : 'sell',
    amount,
    ts,
    signature: logs[0].transactionHash,
    source: 'evm-logs'
  }]
}

/**
 * Lot de journaux, éventuellement multi-tokens → swaps.
 *
 * @param {Array} logs          journaux Transfer bruts
 * @param {Map} meta            adresse du token (minuscules) → { decimals, pools:Set }
 * @param {Map} horodatages     numéro de bloc (hex) → epoch ms, si connu
 */
export function parseBatchEvm(logs, meta = new Map(), horodatages = new Map()) {
  const parTx = grouperParTransaction(logs)
  if (!parTx.size) return []

  const infrastructure = detecterInfrastructure(parTx)
  const out = []

  for (const [, group] of parTx) {
    // Une transaction peut toucher plusieurs tokens : on traite chacun à part,
    // sans quoi les flux se mélangeraient et désigneraient le mauvais wallet.
    const parToken = new Map()
    for (const l of group) {
      const a = String(l.address).toLowerCase()
      const arr = parToken.get(a) ?? []
      arr.push(l)
      parToken.set(a, arr)
    }

    for (const [token, sousGroupe] of parToken) {
      const m = meta.get(token)
      if (!m) continue                        // token hors périmètre
      try {
        out.push(...parseTransactionEvm(sousGroupe, {
          mint: token,
          decimals: m.decimals ?? 18,
          ts: horodatages.get(sousGroupe[0].blockNumber) ?? 0,
          infrastructure,
          pools: m.pools ?? new Set()
        }))
      } catch (e) {
        log.warn({ err: e.message }, 'journal illisible')
      }
    }
  }

  return out
}
