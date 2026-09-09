/**
 * ÉTAGE 3 — Surveillance et tiers
 *
 * Ordonnanceur fondé sur `next_check_at` : un parcours d'index, jamais un scan
 * des 4 000 tokens. Le lot Mobula (50 tokens pour 1 crédit) fait le reste.
 *
 *   sans lot ni tiers : 1 152 000 appels/jour
 *   avec lot + tiers  :     ~3 100 crédits/jour
 *
 * Le profil de liquidité complet (somme des pools) coûte 1 appel PAR token :
 * il est donc réservé aux tokens qui approchent le premier seuil.
 */

import { getSource } from '../../adapters/sources/index.js'
import * as tokensRepo from '../../repos/tokens.js'
import * as metricsRepo from '../../repos/metrics.js'
import { decideTier, hasActivity, pickPrimaryPool } from '../tiers.js'
import { mod } from '../../core/logger.js'

const log = mod('stage:monitoring')
const MIN = 60_000

export async function monitor(cfg, { limit = 1000 } = {}) {
  const src = getSource(cfg)
  const due = await tokensRepo.dueForMonitoring(limit)

  const stats = {
    echus: due.length, releves: 0, sansDonnees: 0,
    tiers: {}, archives: 0, profilsLiquidite: 0, poolsAjoutes: 0, points: 0
  }
  if (!due.length) return stats

  // --- relevé de marché, par lots de 50 ------------------------------------
  const refs = due.map(t => ({ _id: t._id, chain: t.chain, address: t.address }))
  const market = await src.getMarketData(refs)

  // Seuil au-delà duquel on paie le profil de liquidité complet :
  // la moitié du premier palier de déclenchement.
  const profileFloor = cfg.thresholds.trigger[0] * (cfg.sources.liquidity_profile_ratio ?? 0.5)

  const points = []
  const majOps = []
  const now = Date.now()

  for (const token of due) {
    const m = market.get(token._id) ?? null
    if (!m) stats.sansDonnees++

    // `market/data` renvoie des zéros sur les tokens très frais que Mobula n'a
    // pas encore indexés : on ne laisse pas un zéro écraser une valeur connue.
    const merged = m && (m.mc || m.price)
      ? m
      : { ...m, mc: token.market?.mc ?? null, price: token.market?.price ?? null }

    const active = hasActivity(token.velocity, merged, token)
    const enriched = { ...token, market: { ...token.market, mc: merged?.mc ?? token.market?.mc } }
    if (active) enriched.last_activity_at = new Date()

    const tier = decideTier(enriched, cfg, { now })
    stats.tiers[tier.tier] = (stats.tiers[tier.tier] ?? 0) + 1
    if (tier.tier === 'archived') stats.archives++

    // --- profil de liquidité : uniquement près du seuil ---------------------
    let liquidity = null
    let primaryPool = null
    if ((merged?.mc ?? 0) >= profileFloor && typeof src.getLiquidityProfile === 'function') {
      try {
        const p = await src.getLiquidityProfile(
          { chain: token.chain, address: token.address }, merged)
        liquidity = p
        stats.profilsLiquidite++

        const added = await tokensRepo.mergePools(token._id, p.markets?.pools ?? [])
        stats.poolsAjoutes += added
        primaryPool = p.markets?.aggregated?.primaryPool ?? null
      } catch (e) {
        log.debug({ token: token._id, err: e.message }, 'profil de liquidité indisponible')
      }
    }
    if (!primaryPool) primaryPool = pickPrimaryPool(token.pools)

    majOps.push(tokensRepo.buildMarketUpdateOp(token._id, {
      market: merged,
      tier,
      nextCheckAt: tier.nextCheckMinutes ? new Date(now + tier.nextCheckMinutes * MIN) : null,
      active,
      liquidity,
      primaryPool
    }))

    points.push(metricsRepo.buildPoint(token, merged, token.velocity))
    stats.releves++
  }

  await tokensRepo.bulkOps('tokens', majOps)
  stats.points = await metricsRepo.writeSnapshots(points)
  log.info(stats, 'surveillance')
  return stats
}
