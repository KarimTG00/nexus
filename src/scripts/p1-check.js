/**
 * Validation de la phase P1.
 *
 * Critère (docs/roadmap.md) : getNewListings(), getMarketData() en lot de 50
 * et getTokenMarkets() renvoient des données normalisées, et 100 appels
 * d'affilée passent sans 429.
 *
 * Usage : npm run p1
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { active, enabledChains } from '../core/config/store.js'
import { getSource } from '../adapters/sources/index.js'
import { CAP } from '../core/types/datasource.js'
import { fromMobula } from '../core/chains.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()
  const cfg = await active()
  const src = getSource(cfg)
  const chains = enabledChains(cfg).map(fromMobula).filter(Boolean)

  console.log('\n\x1b[1mValidation P1 — couche DataSource\x1b[0m\n')
  console.log(`Source : ${src.name} | capacités : ${[...src.capabilities].join(', ')}`)
  console.log(`Chaînes : ${chains.join(', ')}\n`)

  // --- 1. Découverte -------------------------------------------------------
  console.log('1. getNewListings()')
  const listings = await src.getNewListings(chains)
  if (!listings.length) { ko("aucun token renvoyé"); process.exitCode = 1; return }
  ok(`${listings.length} tokens normalisés`)

  const byBucket = listings.reduce((a, l) => (a[l.bucket] = (a[l.bucket] ?? 0) + 1, a), {})
  ok(`buckets : ${Object.entries(byBucket).map(([k, v]) => `${k}=${v}`).join(' ')}`)

  // Complétude des champs indispensables à l'admission
  const need = {
    'adresse': l => Boolean(l.address),
    'symbole': l => Boolean(l.symbol),
    'déployeur': l => Boolean(l.deployer),
    'pool': l => Boolean(l.pool.address),
    'liquidité': l => l.pool.liquidityUsd !== null,
    'createdAt': l => Boolean(l.createdAt),
    'holders': l => l.holders.count !== null,
    'top10': l => l.holders.top10Pct !== null,
    'vélocité 5min': l => l.velocity['5min']?.traders !== null
  }
  for (const [label, fn] of Object.entries(need)) {
    const n = listings.filter(fn).length
    const pct = Math.round(n / listings.length * 100)
    ;(pct >= 90 ? ok : pct >= 50 ? warn : ko)(`${label.padEnd(15)} présent sur ${pct}% (${n}/${listings.length})`)
  }

  const ages = listings.filter(l => l.createdAt)
    .map(l => (Date.now() - l.createdAt) / 60000).sort((a, b) => a - b)
  if (ages.length) ok(`plus récent : ${ages[0].toFixed(1)} min | médiane : ${ages[Math.floor(ages.length / 2)].toFixed(0)} min`)

  const ex = listings.find(l => l.symbol) ?? listings[0]
  console.log(`\n  exemple : ${ex.symbol ?? '?'} (${ex._id})`)
  console.log(`            liquidité ${ex.pool.liquidityUsd} | holders ${ex.holders.count} | top10 ${ex.holders.top10Pct?.toFixed(1)}%`)
  console.log(`            5min → ${JSON.stringify(ex.velocity['5min'])}`)

  // --- 2. Lot --------------------------------------------------------------
  console.log('\n2. getMarketData() — lot')
  const refs = listings.slice(0, cfg.sources.batch_size)
    .map(l => ({ _id: l._id, chain: l.chain, address: l.address }))
  const before = (await src.stats()).used
  const market = await src.getMarketData(refs)
  const cost = (await src.stats()).used - before

  ;(market.size > 0 ? ok : ko)(`${refs.length} tokens demandés → ${market.size} reçus pour ${cost} crédit(s)`)
  if (market.size) {
    const m = [...market.values()].find(v => v.mc) ?? [...market.values()][0]
    ok(`exemple : ${m._id} → mc=${m.mc} price=${m.price} liq=${m.liquidityUsd}`)
    const withMc = [...market.values()].filter(v => v.mc !== null).length
    ;(withMc / market.size >= 0.5 ? ok : warn)(`market cap présent sur ${Math.round(withMc / market.size * 100)}%`)
  }

  // --- 3. Pools + vélocité -------------------------------------------------
  console.log('\n3. getTokenMarkets() — pools et vélocité')
  const target = [...market.values()].find(v => v.mc > 0) ?? refs[0]
  const tm = await src.getTokenMarkets({ chain: target.chain, address: target.address })
  ;(tm.pools.length ? ok : ko)(`${tm.pools.length} pools (${tm.aggregated.activePoolCount} actifs)`)
  ok(`liquidité agrégée ${tm.aggregated.liquidityUsd?.toFixed(0)} | part du pool principal ${(tm.aggregated.primaryShare * 100)?.toFixed(0)}%`)
  ;(tm.aggregated.liquidityBurnPct !== null ? ok : warn)(`liquidityBurnPct = ${tm.aggregated.liquidityBurnPct}`)
  ok(`vélocité agrégée 5min → ${JSON.stringify(tm.aggregated.velocity['5min'])}`)

  // --- 4. Résistance : 100 appels ------------------------------------------
  // Les échecs sont comptés DANS la source (drainFailures) et dans le limiter :
  // getMarketData tolère un lot manqué, donc un try/catch ici ne verrait rien.
  console.log('\n4. Résistance — 100 appels d\'affilée')
  src.drainFailures()
  const base = await src.stats()
  const t0 = Date.now()

  for (let i = 0; i < 100; i++) await src.getMarketData(refs.slice(0, 5))

  const after = await src.stats()
  const failures = src.drainFailures()
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const calls = after.calls - base.calls
  const errors = after.errors - base.errors
  const limited = after.rateLimited - base.rateLimited

  ;(errors === 0 ? ok : ko)(
    `${calls} appels en ${secs}s — ${errors} en échec, ${limited} throttlés, ${failures.length} lots perdus`)
  if (failures.length) {
    const sample = failures[0]
    ko(`exemple : ${sample.op} ${sample.chain} → ${String(sample.err).slice(0, 100)}`)
  }
  ;(after.intervalMs === base.intervalMs ? ok : warn)(
    `intervalle adaptatif : ${base.intervalMs} → ${after.intervalMs} ms`)
  ok(`quota : ${after.used}/${after.budget} crédits (${after.pct}%)`)

  // --- verdict -------------------------------------------------------------
  const passed = listings.length > 0 && market.size > 0 && tm.pools.length > 0 && errors === 0
  console.log(passed
    ? '\n\x1b[1m\x1b[32mP1 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP1 NON validée — voir les lignes ✗ ci-dessus.\x1b[0m\n')
  process.exitCode = passed ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message); console.error(e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
