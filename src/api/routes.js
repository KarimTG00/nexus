/**
 * Routes de lecture du dashboard.
 *
 * Règle (docs/face1-pipeline.md) : le dashboard NE CALCULE RIEN. Toutes les
 * requêtes ici sont des lectures indexées ou des lectures de collections
 * `analytics_*` déjà agrégées par la face 2. Aucune agrégation à la volée sur
 * des millions de documents — une page qui met trente secondes à charger n'est
 * pas consultée.
 */

import { col } from '../core/db/client.js'
import * as health from '../repos/health.js'
import { active } from '../core/config/store.js'

const TRI = {
  mc: { 'market.mc': -1 },
  recent: { discovered_at: -1 },
  age: { created_at: -1 },
  liquidite: { 'market.liquidity_usd': -1 },
  holders: { 'holders.count': -1 }
}

/** Score d'intérêt courant, dérivé de la vélocité stockée. */
const interet = v => {
  const w = v?.['5min']
  return w?.buyers != null && w?.sellers != null ? w.buyers - w.sellers : null
}

/**
 * Liste paginée. Projection volontairement étroite : le document token porte
 * des tableaux (pools, filtres, candidates) inutiles en vue liste.
 */
export async function listTokens({ status, chain, sort = 'mc', limit = 50, offset = 0, q } = {}) {
  const filtre = {}
  if (status) filtre.status = { $in: String(status).split(',') }
  if (chain) filtre.chain = { $in: String(chain).split(',') }
  if (q) filtre.symbol = { $regex: String(q).replace(/[^\w$]/g, ''), $options: 'i' }

  const projection = {
    symbol: 1, name: 1, chain: 1, address: 1, status: 1, tier: 1,
    'market.mc': 1, 'market.price': 1, 'market.liquidity_usd': 1, 'market.volume_24h': 1,
    'holders.count': 1, 'holders.top10Pct': 1,
    velocity: 1, created_at: 1, discovered_at: 1, launchpad: 1,
    triggers: 1, muted: 1, 'security.checked': 1, 'bonding.bonded': 1,
    'liquidity.aggregate': 1, 'liquidity.divergence': 1
  }

  const [docs, total] = await Promise.all([
    col('tokens').find(filtre, { projection })
      .sort(TRI[sort] ?? TRI.mc)
      .skip(Number(offset) || 0)
      .limit(Math.min(Number(limit) || 50, 200))
      .toArray(),
    col('tokens').countDocuments(filtre)
  ])

  return {
    total,
    offset: Number(offset) || 0,
    tokens: docs.map(t => ({
      id: t._id,
      symbol: t.symbol,
      name: t.name,
      chain: t.chain,
      address: t.address,
      status: t.status,
      tier: t.tier,
      muted: Boolean(t.muted),
      launchpad: t.launchpad,
      mc: t.market?.mc ?? null,
      price: t.market?.price ?? null,
      liquidity: t.liquidity?.aggregate ?? t.market?.liquidity_usd ?? null,
      volume24h: t.market?.volume_24h ?? null,
      holders: t.holders?.count ?? null,
      top10: t.holders?.top10Pct ?? null,
      interest: interet(t.velocity),
      traders5m: t.velocity?.['5min']?.traders ?? null,
      bonded: t.bonding?.bonded ?? null,
      securityChecked: t.security?.checked ?? null,
      createdAt: t.created_at ?? null,
      discoveredAt: t.discovered_at ?? null,
      triggers: (t.triggers ?? []).length,
      alerted: (t.triggers ?? []).some(x => x.decision === 'alerted')
    }))
  }
}

/** Détail complet d'un token — le résultat des analyses le concernant. */
export async function tokenDetail(id) {
  const token = await col('tokens').findOne({ _id: id })
  if (!token) return null

  const [snapshots, outcomes, metrics, positions] = await Promise.all([
    col('trigger_snapshots').find({ token: id }).sort({ ts: -1 }).toArray(),
    col('outcomes').find({ token: id }).sort({ triggered_at: -1 }).toArray(),
    col('token_metrics').find({ 'meta.token': id }).sort({ ts: -1 }).limit(120).toArray(),
    col('positions').countDocuments({ token: id })
  ])

  const rejet = snapshots.length ? null : await col('rejected_seen').findOne({ _id: id })

  return {
    token: {
      id: token._id,
      symbol: token.symbol,
      name: token.name,
      chain: token.chain,
      address: token.address,
      status: token.status,
      tier: token.tier,
      tierReason: token.tier_reason ?? null,
      muted: Boolean(token.muted),
      launchpad: token.launchpad,
      deployer: token.deployer,
      createdAt: token.created_at,
      discoveredAt: token.discovered_at,
      admittedAt: token.admitted_at,
      archivedAt: token.archived_at,
      nextCheckAt: token.next_check_at,
      configVersion: token.config_version,
      market: token.market ?? {},
      liquidity: token.liquidity ?? {},
      holders: token.holders ?? {},
      velocity: token.velocity ?? {},
      bonding: token.bonding ?? {},
      security: token.security ?? {},
      socials: token.socials ?? null,
      pools: token.pools ?? [],
      primaryPool: token.primary_pool,
      isMultichain: token.is_multichain,
      contractsCount: token.contracts_count,
      candidates: token.candidates ?? {},
      admissionFilters: token.admission_filters ?? [],
      activityFilters: token.activity_filters ?? [],
      rejectionReason: token.rejection_reason ?? null
    },
    rejet,
    snapshots,
    outcomes,
    positions,
    // Série chronologique, remise à l'endroit pour l'affichage
    metrics: metrics.reverse().map(m => ({
      ts: m.ts, mc: m.mc, price: m.price, liquidity: m.liquidity_usd,
      score: m.score, traders: m.unique_traders, holders: m.holders
    }))
  }
}

/** Vue d'ensemble : entonnoir, santé, rapports de la face 2. */
export async function overview() {
  const [funnel, h, cfg, byStatus, byChain, blind, perf, counts] = await Promise.all([
    health.funnel(),
    health.health(),
    active(),
    col('tokens').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    col('tokens').aggregate([{ $group: { _id: '$chain', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    col('analytics_blindspots').findOne({}, { sort: { period: -1 } }),
    col('analytics_filter_perf').findOne({}, { sort: { period: -1 } }),
    Promise.all([
      col('tokens').countDocuments(),
      col('trigger_snapshots').countDocuments(),
      col('outcomes').countDocuments(),
      col('alerts').countDocuments(),
      col('positions').countDocuments()
    ])
  ])

  return {
    health: h,
    funnel,
    config: {
      version: cfg._id,
      alertsEnabled: cfg.features.alerts.enabled,
      chains: Object.entries(cfg.features.chains).filter(([, v]) => v).map(([k]) => k),
      thresholds: cfg.thresholds,
      intervalMin: cfg.sources.discovery_interval_min
    },
    counts: {
      tokens: counts[0], snapshots: counts[1], outcomes: counts[2],
      alerts: counts[3], positions: counts[4]
    },
    byStatus: Object.fromEntries(byStatus.map(x => [x._id, x.n])),
    byChain: Object.fromEntries(byChain.map(x => [x._id, x.n])),
    blindspots: blind,
    filterPerf: perf
  }
}

/** Dernières alertes envoyées ou retenues. */
export async function recentTriggers({ limit = 30, decision } = {}) {
  const filtre = decision ? { decision } : {}
  const rows = await col('trigger_snapshots').find(filtre)
    .sort({ ts: -1 }).limit(Math.min(Number(limit) || 30, 100)).toArray()

  const ids = rows.map(r => r._id)
  const outs = await col('outcomes').find({ _id: { $in: ids } }).toArray()
  const byId = new Map(outs.map(o => [o._id, o]))

  return rows.map(r => ({
    id: r._id, token: r.token, symbol: r.symbol, chain: r.chain,
    threshold: r.threshold, decision: r.decision, score: r.score,
    rejectionReason: r.rejection_reason, ts: r.ts,
    mc: r.context?.mc ?? null,
    outcome: byId.get(r._id)
      ? { verdict: byId.get(r._id).verdict, multiple: byId.get(r._id).multiple_max }
      : null
  }))
}

/**
 * Rapports de la face 2 — lecture pure des collections `analytics_*`,
 * déjà agrégées par le worker analytique. Le dashboard ne recalcule rien.
 */
export async function analytics() {
  const [blind, perf, funnels, verdicts, positions] = await Promise.all([
    col('analytics_blindspots').find({}).sort({ period: -1 }).limit(8).toArray(),
    col('analytics_filter_perf').find({}).sort({ period: -1 }).limit(8).toArray(),
    col('analytics_funnel').find({}).sort({ period: -1 }).limit(14).toArray(),
    col('outcomes').aggregate([
      { $group: {
          _id: { verdict: '$verdict', decision: '$decision' },
          n: { $sum: 1 },
          multiple_moyen: { $avg: '$multiple_max' },
          multiple_max: { $max: '$multiple_max' }
      } },
      { $sort: { n: -1 } }
    ]).toArray(),
    col('positions').estimatedDocumentCount()
  ])

  // Distribution des scores des tokens alertés vs rejetés — permet de voir
  // si le seuil d'alerte sépare réellement deux populations.
  const scores = await col('trigger_snapshots').aggregate([
    { $match: { score: { $ne: null } } },
    { $bucket: {
        groupBy: '$score',
        boundaries: [0, 20, 40, 60, 70, 80, 90, 101],
        default: 'autre',
        output: { n: { $sum: 1 }, alertes: { $sum: { $cond: [{ $eq: ['$decision', 'alerted'] }, 1, 0] } } }
    } }
  ]).toArray()

  return {
    blindspots: blind,
    filterPerf: perf,
    funnels,
    verdicts: verdicts.map(v => ({
      ...v._id, n: v.n,
      multiple_moyen: v.multiple_moyen ? +v.multiple_moyen.toFixed(2) : null,
      multiple_max: v.multiple_max ? +v.multiple_max.toFixed(2) : null
    })),
    scores,
    positions
  }
}
