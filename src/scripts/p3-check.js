/**
 * Validation de la phase P3.
 *
 * Critère (docs/roadmap.md) : un token suivi voit son MC évoluer en base et
 * change de tier quand son activité change.
 *
 * Usage : npm run p3
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active } from '../core/config/store.js'
import { getSource } from '../adapters/sources/index.js'
import { monitor } from '../pipeline/stages/monitoring.js'
import { decideTier } from '../pipeline/tiers.js'
import * as metricsRepo from '../repos/metrics.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()
  const cfg = await active()
  const src = getSource(cfg)

  console.log('\n\x1b[1mValidation P3 — surveillance et tiers\x1b[0m\n')

  // --- 1. Logique de tiers (pur, sans réseau) ------------------------------
  console.log('1. Logique de tiers')
  const cas = [
    ['MC au-dessus du plancher', { market: { mc: 120_000 }, created_at: new Date() }, 'hot'],
    ['vélocité positive', { market: { mc: 5_000 }, velocity: { '5min': { buyers: 12, sellers: 3 } }, created_at: new Date() }, 'hot'],
    ['activité il y a 2h', { market: { mc: 5_000 }, last_activity_at: new Date(Date.now() - 2 * 3600e3) }, 'warm'],
    ['inactif 12h', { market: { mc: 5_000 }, last_activity_at: new Date(Date.now() - 12 * 3600e3) }, 'cold'],
    ['mort : 96h + petit MC', { market: { mc: 3_000 }, last_activity_at: new Date(Date.now() - 96 * 3600e3) }, 'archived'],
    ['silencieux mais gros MC', { market: { mc: 40_000 }, last_activity_at: new Date(Date.now() - 96 * 3600e3) }, 'cold']
  ]
  let tiersOk = true
  for (const [label, token, attendu] of cas) {
    const r = decideTier(token, cfg)
    const bon = r.tier === attendu
    if (!bon) tiersOk = false
    ;(bon ? ok : ko)(`${label.padEnd(28)} → ${r.tier} (${r.reason}, ${r.nextCheckMinutes ?? '—'} min)`)
  }

  // --- 2. Cycle de surveillance --------------------------------------------
  console.log('\n2. Cycle de surveillance')
  const eligibles = await col('tokens').countDocuments({
    status: { $in: ['tracked', 'triggered', 'alerted'] }
  })
  const echus = await col('tokens').countDocuments({
    status: { $in: ['tracked', 'triggered', 'alerted'] },
    next_check_at: { $lte: new Date() }
  })
  ok(`${eligibles} tokens en surveillance, ${echus} échus`)

  const before = await src.stats()
  const usedBefore = before.primary?.used ?? before.used ?? 0
  const s = await monitor(cfg)
  const after = await src.stats()
  const usedAfter = after.primary?.used ?? after.used ?? 0

  ok(`${s.echus} échus → ${s.releves} relevés, ${s.sansDonnees} sans données`)
  ok(`tiers : ${Object.entries(s.tiers).map(([k, v]) => `${k}=${v}`).join(' ') || 'aucun'}`)
  ok(`profils de liquidité : ${s.profilsLiquidite} | pools ajoutés : ${s.poolsAjoutes}`)
  ok(`points de mesure écrits : ${s.points}`)
  ok(`crédits consommés : ${usedAfter - usedBefore} pour ${s.releves} tokens`)
  if (s.releves > 0) {
    const ratio = (usedAfter - usedBefore) / s.releves
    ;(ratio < 0.1 ? ok : warn)(`coût par token : ${ratio.toFixed(3)} crédit`)
  }

  // --- 3. Persistance ------------------------------------------------------
  console.log('\n3. Persistance')
  const nMetrics = await col('token_metrics').countDocuments()
  ;(nMetrics > 0 ? ok : ko)(`token_metrics : ${nMetrics} points`)

  const byTier = await col('tokens').aggregate([
    { $group: { _id: '$tier', n: { $sum: 1 } } }, { $sort: { n: -1 } }
  ]).toArray()
  ok(`répartition : ${byTier.map(t => `${t._id}=${t.n}`).join(' ')}`)

  const due = await col('tokens').aggregate([
    { $match: { next_check_at: { $ne: null } } },
    { $group: { _id: null, min: { $min: '$next_check_at' }, max: { $max: '$next_check_at' } } }
  ]).toArray()
  if (due[0]) {
    const dansMin = (due[0].min - Date.now()) / 60000
    const dansMax = (due[0].max - Date.now()) / 60000
    ok(`prochaines échéances : de ${dansMin.toFixed(0)} à ${dansMax.toFixed(0)} min`)
  }

  // --- 4. Un token précis, en détail ---------------------------------------
  console.log('\n4. Détail d\'un token suivi')
  const sample = await col('tokens').findOne(
    { status: 'tracked', 'market.mc': { $gt: 0 } }, { sort: { 'market.mc': -1 } })
  if (sample) {
    console.log(`  ${sample.symbol ?? '?'} (${sample._id})`)
    ok(`mc ${Math.round(sample.market.mc).toLocaleString()} | tier ${sample.tier} (${sample.tier_reason ?? '?'})`)
    ok(`pools ${sample.pools?.length ?? 0} | primary ${String(sample.primary_pool).slice(0, 16)}`)
    const L = sample.liquidity ?? {}
    ;(L.consensus != null ? ok : warn)(
      `liquidité consensus=${L.consensus != null ? Math.round(L.consensus).toLocaleString() : '—'} ` +
      `aggregate=${L.aggregate != null ? Math.round(L.aggregate).toLocaleString() : '—'} ` +
      `divergence=${L.divergence ?? '—'}x`)
    ;(sample.asset_id != null || sample.contracts_count != null ? ok : warn)(
      `multichain : asset_id=${sample.asset_id ?? '—'} contrats=${sample.contracts_count ?? '—'}`)

    const pts = await metricsRepo.recentSnapshots(sample._id, 3)
    ;(pts.length ? ok : warn)(`${pts.length} points de mesure pour ce token`)
    for (const p of pts) {
      console.log(`      ${p.ts.toISOString().slice(11, 19)} mc=${Math.round(p.mc ?? 0)} ` +
        `score=${p.score ?? '—'} traders=${p.unique_traders ?? '—'}`)
    }
  } else {
    warn('aucun token suivi avec un MC connu')
  }

  const passed = tiersOk && s.releves > 0 && nMetrics > 0
  console.log(passed
    ? '\n\x1b[1m\x1b[32mP3 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP3 NON validée.\x1b[0m\n')
  process.exitCode = passed ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
