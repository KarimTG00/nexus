/**
 * `outcomes` — ce que chaque token est devenu.
 *
 * Registre APPEND-ONLY IRREMPLAÇABLE, au même titre que trigger_snapshots :
 * le passé du marché ne se rejoue pas.
 *
 * Point capital : on suit TOUS les tokens déclenchés, alertés ET rejetés.
 * C'est le seul moyen de répondre un jour à « ce filtre m'a-t-il protégé ou
 * coûté de l'argent ? ». Sans les rejetés, M5 n'a aucun groupe de comparaison.
 */

import { col } from '../core/db/client.js'
import { SCHEMA_VERSION } from '../core/db/schema.js'
import { mod } from '../core/logger.js'

const log = mod('repo:outcomes')
const H = 3_600_000

export const VERDICTS = ['SUCCESS', 'SURVIVED', 'DEAD', 'RUGGED', 'PENDING']

/** Créé au moment du déclenchement, en même temps que le snapshot. */
export function buildOutcomeDoc(snapshot, checkpointsHours) {
  const first = Math.min(...checkpointsHours)
  return {
    _id: snapshot._id,
    schema_version: SCHEMA_VERSION,
    token: snapshot.token,
    chain: snapshot.chain,
    symbol: snapshot.symbol,
    threshold: snapshot.threshold,
    decision: snapshot.decision,          // dupliqué : évite une jointure dans M5
    config_version: snapshot.config_version,

    triggered_at: snapshot.ts,
    mc_at_trigger: snapshot.context?.mc ?? null,
    liquidity_at_trigger: snapshot.context?.liquidity_aggregate
      ?? snapshot.context?.liquidity_consensus ?? null,

    checkpoints: {},
    pending_checkpoints: [...checkpointsHours].sort((a, b) => a - b),
    next_checkpoint_at: new Date(Date.now() + first * H),

    mc_max: snapshot.context?.mc ?? null,
    multiple_max: 1,
    time_to_peak_hours: 0,
    drawdown_from_peak_pct: 0,

    alive: true,
    rugged: false,
    rug_ts: null,
    rug_type: null,
    verdict: 'PENDING'
  }
}

export async function createMany(docs) {
  if (!docs.length) return 0
  try {
    const r = await col('outcomes').insertMany(docs, { ordered: false })
    return r.insertedCount
  } catch (e) {
    if (e.code === 11000 || e.writeErrors) return e.result?.nInserted ?? 0
    throw e
  }
}

/** Outcomes dont un point de contrôle est échu. */
export async function due(limit = 500) {
  return col('outcomes').find({
    verdict: 'PENDING',
    next_checkpoint_at: { $lte: new Date(), $ne: null }
  }).sort({ next_checkpoint_at: 1 }).limit(limit).toArray()
}

export async function bulkUpdate(ops) {
  if (!ops.length) return 0
  const r = await col('outcomes').bulkWrite(ops, { ordered: false })
  return r.modifiedCount ?? 0
}

/**
 * Verdict final.
 *
 * `RUGGED` prime sur tout : un token qui fait ×10 puis retire sa liquidité
 * n'est pas un succès qu'on veut apprendre à attraper.
 */
export function computeVerdict({ rugged, multipleMax, alive }, cfg) {
  if (rugged) return 'RUGGED'
  const seuil = cfg?.outcome?.success_multiple ?? 5
  if (multipleMax >= seuil) return 'SUCCESS'
  return alive ? 'SURVIVED' : 'DEAD'
}

export async function stats({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400_000)
  const rows = await col('outcomes').aggregate([
    { $match: { triggered_at: { $gte: since } } },
    { $group: {
        _id: { verdict: '$verdict', decision: '$decision' },
        n: { $sum: 1 },
        multiple_moyen: { $avg: '$multiple_max' }
    } },
    { $sort: { n: -1 } }
  ]).toArray()
  return rows.map(r => ({ ...r._id, n: r.n, multiple_moyen: +(r.multiple_moyen ?? 0).toFixed(2) }))
}

/**
 * LE tableau de M5 : pour chaque filtre, le taux de réussite des tokens qu'il
 * a rejetés, comparé au taux de base des alertés. Un filtre dont les rejets
 * réussissent autant que les alertes ne discrimine rien.
 */
export async function filterEfficacy({ days = 60, successMultiple = 5 } = {}) {
  const since = new Date(Date.now() - days * 86400_000)

  const rows = await col('outcomes').aggregate([
    { $match: { triggered_at: { $gte: since }, verdict: { $ne: 'PENDING' } } },
    { $lookup: {
        from: 'trigger_snapshots', localField: '_id', foreignField: '_id', as: 'snap' } },
    { $unwind: '$snap' },
    { $unwind: '$snap.filters' },
    { $match: { 'snap.filters.passed': false } },
    { $group: {
        _id: '$snap.filters.name',
        rejetes: { $sum: 1 },
        succes: { $sum: { $cond: [{ $gte: ['$multiple_max', successMultiple] }, 1, 0] } }
    } }
  ]).toArray()

  const base = await col('outcomes').aggregate([
    { $match: { triggered_at: { $gte: since }, decision: 'alerted', verdict: { $ne: 'PENDING' } } },
    { $group: {
        _id: null, n: { $sum: 1 },
        succes: { $sum: { $cond: [{ $gte: ['$multiple_max', successMultiple] }, 1, 0] } }
    } }
  ]).toArray()

  const taux = base[0]?.n ? base[0].succes / base[0].n : null

  return {
    reference: { alertes: base[0]?.n ?? 0, taux_succes: taux },
    filtres: rows.map(r => ({
      filtre: r._id,
      rejetes: r.rejetes,
      succes_apres_rejet: r.succes,
      taux: r.rejetes ? +(r.succes / r.rejetes).toFixed(3) : 0
    })).sort((a, b) => b.taux - a.taux)
  }
}
