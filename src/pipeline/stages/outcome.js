/**
 * ÉTAGE 8 et M1 — Suivi d'outcome.
 *
 * On relève TOUS les tokens déclenchés — alertés comme rejetés — à T+1h, 6h,
 * 24h et 7j. Sans les rejetés, M5 n'aurait aucun groupe de comparaison et ne
 * pourrait jamais dire si un filtre protège ou coûte de l'argent.
 *
 * ⚠️ RUG ≠ MIGRATION. Vus depuis un seul pool, les deux sont identiques : la
 * liquidité disparaît. Confondre les deux empoisonnerait M1 (verdicts faux),
 * M3 (des traders honnêtes classés « initiés ») et M4 (des déployeurs
 * légitimes blacklistés) — et cette blacklist agit ensuite à l'admission,
 * donc l'erreur se propage et s'auto-entretient.
 */

import { getSource } from '../../adapters/sources/index.js'
import * as outcomesRepo from '../../repos/outcomes.js'
import { mod } from '../../core/logger.js'

const log = mod('stage:outcome')
const H = 3_600_000

/**
 * Un effondrement de liquidité est-il un rug, ou une migration de pool ?
 *
 * Migration : la liquidité réapparaît dans un pool créé récemment. C'est le
 * cas systématique à la graduation d'un launchpad — la courbe se vide pour
 * alimenter un vrai pool AMM.
 */
export function classifyLiquidityDrop({ before, after, pools, windowMinutes = 60 }) {
  if (!before || before <= 0) return { rugged: false, type: null, reason: 'liquidité initiale inconnue' }

  const dropPct = (before - after) / before
  if (dropPct < 0.8) return { rugged: false, type: null, reason: 'pas d\'effondrement' }

  // Un pool récent porte-t-il une liquidité comparable ?
  const cutoff = Date.now() - windowMinutes * 60_000
  const remplacement = (pools ?? []).find(p =>
    p.createdAt && p.createdAt.getTime() >= cutoff &&
    (p.liquidityUsd ?? 0) >= before * 0.3)

  if (remplacement) {
    return { rugged: false, type: 'migration', reason: `pool de remplacement ${remplacement.address}` }
  }

  // Reste de la liquidité ailleurs ? Fragmentation, pas retrait.
  const totalActif = (pools ?? []).reduce((s, p) => s + (p.liquidityUsd ?? 0), 0)
  if (totalActif >= before * 0.5) {
    return { rugged: false, type: null, reason: 'liquidité présente sur d\'autres pools' }
  }

  return {
    rugged: true,
    type: 'lp_pull',
    reason: `liquidité ${Math.round(before)} → ${Math.round(after)} (−${Math.round(dropPct * 100)}%), aucun remplacement`
  }
}

/** Crée les outcomes des déclenchements du cycle. Appelé par l'étage 4. */
export async function openOutcomes(snapshots, cfg) {
  const docs = snapshots
    .filter(Boolean)
    .map(s => outcomesRepo.buildOutcomeDoc(s, cfg.outcome_checkpoints))
  return outcomesRepo.createMany(docs)
}

// ---------------------------------------------------------------------------

export async function trackOutcomes(cfg, { limit = 300 } = {}) {
  const pending = await outcomesRepo.due(limit)
  const stats = { echus: pending.length, releves: 0, rugs: 0, migrations: 0, verdicts: {} }
  if (!pending.length) return stats

  const src = getSource(cfg)

  // Relevé de marché par lots — le même mécanisme que l'étage 3
  const refs = pending.map(o => {
    const i = o.token.indexOf(':')
    return { _id: o.token, chain: o.token.slice(0, i), address: o.token.slice(i + 1) }
  })
  const market = await src.getMarketData(refs)

  const ops = []
  const now = new Date()

  for (const o of pending) {
    const m = market.get(o.token)
    const heures = (now - o.triggered_at) / H
    const label = `t${o.pending_checkpoints[0]}h`

    const mc = m?.mc ?? null
    const liq = m?.liquidityUsd ?? null

    // --- rug ou migration ? ------------------------------------------------
    let rug = { rugged: false, type: null, reason: null }
    const effondrement = o.liquidity_at_trigger && liq !== null
      && liq < o.liquidity_at_trigger * 0.2

    if (effondrement && !o.rugged) {
      let pools = []
      try {
        const tm = await src.getTokenMarkets({ chain: refs.find(r => r._id === o.token).chain,
                                               address: refs.find(r => r._id === o.token).address })
        pools = tm.pools ?? []
      } catch { /* sans la liste des pools, on ne tranche pas */ }

      rug = classifyLiquidityDrop({
        before: o.liquidity_at_trigger, after: liq, pools,
        windowMinutes: cfg.outcome?.migration_window_minutes ?? 60
      })
      if (rug.rugged) stats.rugs++
      else if (rug.type === 'migration') stats.migrations++
    }

    // --- pic et drawdown ----------------------------------------------------
    const mcMax = Math.max(o.mc_max ?? 0, mc ?? 0)
    const multiple = o.mc_at_trigger ? +(mcMax / o.mc_at_trigger).toFixed(2) : null
    const drawdown = mcMax > 0 && mc !== null ? +(((mcMax - mc) / mcMax) * 100).toFixed(1) : null
    const alive = liq !== null ? liq >= (cfg.outcome?.alive_liquidity_usd ?? 10_000) : o.alive

    // --- échéance suivante --------------------------------------------------
    const restants = o.pending_checkpoints.filter(h => h > heures)
    const termine = restants.length === 0
    const verdict = termine || rug.rugged
      ? outcomesRepo.computeVerdict({ rugged: rug.rugged || o.rugged, multipleMax: multiple ?? 1, alive }, cfg)
      : 'PENDING'

    if (verdict !== 'PENDING') stats.verdicts[verdict] = (stats.verdicts[verdict] ?? 0) + 1

    ops.push({
      updateOne: {
        filter: { _id: o._id },
        update: {
          $set: {
            [`checkpoints.${label}`]: { at: now, mc, liquidity_usd: liq, hours: +heures.toFixed(2) },
            pending_checkpoints: restants,
            next_checkpoint_at: termine || rug.rugged
              ? null
              : new Date(o.triggered_at.getTime() + restants[0] * H),
            mc_max: mcMax,
            multiple_max: multiple,
            drawdown_from_peak_pct: drawdown,
            ...(mcMax > (o.mc_max ?? 0) ? { time_to_peak_hours: +heures.toFixed(2) } : {}),
            alive,
            ...(rug.rugged ? { rugged: true, rug_ts: now, rug_type: rug.type, rug_reason: rug.reason } : {}),
            ...(rug.type === 'migration' ? { migration_detected_at: now } : {}),
            verdict
          }
        }
      }
    })
    stats.releves++
  }

  await outcomesRepo.bulkUpdate(ops)
  log.info(stats, 'suivi d\'outcome')
  return stats
}
