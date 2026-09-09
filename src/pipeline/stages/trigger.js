/**
 * ÉTAGES 4, 5 et 6 — Déclenchement, analyse approfondie, score.
 *
 * C'est ici que s'écrit `trigger_snapshots`, registre append-only
 * irremplaçable. Tout ce qui n'est pas figé au moment de la décision est
 * perdu : le marché ne se rejoue pas.
 *
 * L'analyse ne tourne que sur les franchissements — quelques dizaines par
 * jour — donc on peut s'y permettre un appel payant par token.
 */

import { getSource } from '../../adapters/sources/index.js'
import { runFilters } from '../filters/index.js'
import { velocitySnapshot } from '../velocity.js'
import { socialPresence } from '../tiers.js'
import { computeScore, loadDistributions } from '../scoring.js'
import * as triggersRepo from '../../repos/triggers.js'
import * as tokensRepo from '../../repos/tokens.js'
import { openOutcomes } from './outcome.js'
import { col } from '../../core/db/client.js'
import { mod } from '../../core/logger.js'

const log = mod('stage:trigger')

/**
 * Tokens ayant franchi un seuil non encore déclenché.
 * On ne cherche que le seuil le PLUS HAUT franchi : un token qui passe
 * directement de 80K à 600K déclenche à 500K, pas trois fois d'affilée.
 */
export async function findCrossings(cfg, { limit = 200 } = {}) {
  const thresholds = [...cfg.thresholds.trigger].sort((a, b) => a - b)
  const floor = thresholds[0]

  const candidates = await col('tokens').find({
    status: { $in: ['tracked', 'alerted'] },
    'market.mc': { $gte: floor }
  }).limit(limit).toArray()

  if (!candidates.length) return []

  const already = await triggersRepo.existingTriggers(candidates.map(t => t._id))

  const out = []
  for (const token of candidates) {
    const mc = token.market?.mc ?? 0
    const crossed = thresholds.filter(t => mc >= t)
    const pending = crossed.filter(t => !already.has(triggersRepo.triggerId(token._id, t)))
    if (pending.length) out.push({ token, threshold: Math.max(...pending), mc })
  }
  return out
}

/** Les 9 métriques candidates de M6 + celles de la source. Aucune n'est un filtre. */
function buildCandidates(token, deep, market) {
  const social = socialPresence(token.socials)
  const liq = deep?.aggregated?.liquidityUsd ?? token.liquidity?.aggregate ?? null
  const mc = market?.mc ?? token.market?.mc ?? null
  const holders = token.holders?.count ?? null
  const traders = deep?.velocity?.traders ?? null
  const ageMin = token.created_at ? (Date.now() - token.created_at) / 60_000 : null

  return {
    ...(token.candidates ?? {}),

    liq_mc_ratio: liq && mc ? +(liq / mc).toFixed(4) : null,
    holders_traders_ratio: holders && traders ? +(holders / traders).toFixed(2) : null,
    age_minutes: ageMin === null ? null : Math.round(ageMin),
    median_buy_size_usd: deep?.velocity?.volumeUsd && deep?.velocity?.buys
      ? +(deep.velocity.volumeUsd / deep.velocity.buys).toFixed(2) : null,
    pool_count: deep?.aggregated?.activePoolCount ?? null,
    primary_pool_share: deep?.aggregated?.primaryShare ?? null,
    liquidity_divergence: token.liquidity?.divergence ?? null,

    social_score: social.score,
    social_channels: social.count,
    social_telegram: social.telegram,

    bonded: token.bonding?.bonded ?? null,
    bonding_percentage: token.bonding?.percentage ?? null,
    launchpad: token.launchpad ?? null,
    chain: token.chain
  }
}

/** Valeurs brutes des sous-scores, avant normalisation en percentiles. */
function buildRawSubscores(deep, filters, token) {
  const v = deep?.velocity ?? {}
  const passed = n => filters.find(f => f.name === n)?.passed
  const val = n => filters.find(f => f.name === n)?.value ?? null

  // Sécurité : marge sous les seuils plutôt que binaire — un top10 à 12 %
  // vaut mieux qu'à 29 %, même si les deux passent.
  const top10 = val('top_holders')
  const securityMargin = top10 === null ? null : Math.max(0, 100 - top10)

  return {
    velocity: v.score ?? null,
    flow: v.buySellRatio === Infinity ? 99 : v.buySellRatio ?? null,
    security: securityMargin,
    social: socialPresence(token.socials).score,
    deployer: token.deployer_reputation_score ?? null   // alimenté par M4 (P11)
  }
}

// ---------------------------------------------------------------------------

export async function processTriggers(cfg, { limit = 200 } = {}) {
  const crossings = await findCrossings(cfg, { limit })
  const stats = { franchissements: crossings.length, alertes: 0, rejetes: {}, sansDonnees: 0, outcomes: 0 }
  if (!crossings.length) return stats

  const src = getSource(cfg)
  const distributions = await loadDistributions()
  const rejectionRates = await triggersRepo.rejectionRates()

  // Un outcome est ouvert pour CHAQUE declenchement, alerte ou rejete :
  // sans les rejetes, M5 n a aucun groupe de comparaison.
  const ouverts = []

  for (const { token, threshold, mc } of crossings) {
    // --- analyse approfondie : 1 appel couvre 5 contrôles -------------------
    let markets = null
    try {
      markets = await src.getTokenMarkets({ chain: token.chain, address: token.address })
    } catch (e) {
      log.warn({ token: token._id, err: e.message }, 'analyse approfondie indisponible')
    }

    const agg = markets?.aggregated ?? {}
    const velocity = velocitySnapshot(
      Object.keys(agg.velocity ?? {}).length ? agg.velocity : token.velocity)

    if (!markets?.pools?.length) stats.sansDonnees++

    const ctx = {
      _id: token._id, chain: token.chain, address: token.address,
      velocity,
      holders: token.holders,
      bonding: token.bonding,
      liquidity: { ...agg, liquidityBurnPct: agg.liquidityBurnPct ?? null }
    }

    const { passed, results, rejectionReason } =
      await runFilters('deep', ctx, cfg, { rejectionRates })

    // --- score --------------------------------------------------------------
    const raw = buildRawSubscores({ ...markets, velocity }, results, token)
    const scored = await computeScore(raw, cfg, { distributions })

    const alertThreshold = cfg.thresholds.alert.min_score
    const decision = passed && scored.score !== null && scored.score >= alertThreshold
      ? 'alerted' : 'rejected'

    if (decision === 'rejected' && passed) {
      stats.rejetes.low_score = (stats.rejetes.low_score ?? 0) + 1
    } else if (rejectionReason) {
      stats.rejetes[rejectionReason] = (stats.rejetes[rejectionReason] ?? 0) + 1
    }

    // --- snapshot : le contexte figé ----------------------------------------
    const snapshot = await triggersRepo.record({
      token: token._id,
      chain: token.chain,
      symbol: token.symbol,
      threshold,
      config_version: cfg._id,

      context: {
        mc,
        age_minutes: token.created_at ? Math.round((Date.now() - token.created_at) / 60_000) : null,
        liquidity_consensus: token.liquidity?.consensus ?? null,
        liquidity_aggregate: agg.liquidityUsd ?? null,
        holders: token.holders?.count ?? null,
        top10_pct: token.holders?.top10Pct ?? null,
        velocity,
        // Le MC de Mobula est AGRÉGÉ sur toutes les chaînes : sur un token
        // multichain, il ne correspond pas à la liquidité locale. Sans ce
        // drapeau, M5 comparerait des grandeurs incompatibles.
        is_multichain: token.is_multichain ?? null,
        contracts_count: token.contracts_count ?? null,
        asset_id: token.asset_id ?? null
      },

      candidates: buildCandidates(token, { ...markets, velocity }, token.market),
      filters: results,
      decision,
      rejection_reason: decision === 'rejected' ? (rejectionReason ?? 'low_score') : null,
      score: scored.score,
      subscores: scored.subscores,
      raw_subscores: scored.raw,
      score_method: scored.method,
      weights_used: scored.weightsUsed,
      score_coverage: scored.coverage,
      analysis_source: markets?.source ?? null
    })

    if (!snapshot) continue          // déjà déclenché sur ce palier
    ouverts.push(snapshot)

    await triggersRepo.appendToToken(token._id, {
      threshold, decision, score: scored.score
    })

    if (decision === 'alerted') stats.alertes++
    log.info({ token: token._id, symbol: token.symbol, threshold, decision, score: scored.score },
      'franchissement')
  }

  stats.outcomes = await openOutcomes(ouverts, cfg)

  log.info(stats, 'déclenchements')
  return stats
}
