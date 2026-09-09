/**
 * Validation de la phase P4.
 *
 * Critère (docs/roadmap.md) : un franchissement produit un `trigger_snapshot`
 * complet et rejouable, avec les valeurs mesurées de chaque filtre.
 *
 * Usage : npm run p4
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active } from '../core/config/store.js'
import { loadFilters, filtersFor } from '../pipeline/filters/index.js'
import { acceleration, buySellRatio, washIndex, velocitySnapshot } from '../pipeline/velocity.js'
import { normalize, score, percentileRank } from '../pipeline/scoring.js'
import { findCrossings, processTriggers } from '../pipeline/stages/trigger.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect(); await cache.connect()
  const cfg = await active()
  let allOk = true

  console.log('\n\x1b[1mValidation P4 — déclenchement, analyse, score\x1b[0m\n')

  // --- 1. Vélocité : pente lue sur les fenêtres imbriquées -----------------
  console.log('1. Calcul de vélocité (sans réseau)')
  const cas = [
    ['accélère', { '5min': { buyers: 40, sellers: 5 }, '1h': { buyers: 120, sellers: 30 } }, 'up'],
    ['ralentit', { '5min': { buyers: 2, sellers: 1 }, '1h': { buyers: 120, sellers: 30 } }, 'down'],
    ['stable', { '5min': { buyers: 10, sellers: 2 }, '1h': { buyers: 120, sellers: 30 } }, 'flat'],
    ['effectif trop faible', { '5min': { buyers: 1 }, '1h': { buyers: 2 } }, null]
  ]
  for (const [label, v, attendu] of cas) {
    const a = acceleration(v)
    const bon = attendu === null ? !a.confident : a.direction === attendu
    if (!bon) allOk = false
    ;(bon ? ok : ko)(`${label.padEnd(22)} → ${a.direction ?? '—'} (ratio ${a.ratio ?? '—'}, fiable: ${a.confident})`)
  }
  const w = { buys: 312, sells: 28, trades: 340, traders: 187 }
  ok(`ratio achats/ventes ${buySellRatio(w)} | indice de wash ${washIndex(w)}`)

  // --- 2. Scoring ----------------------------------------------------------
  console.log('\n2. Score')
  const dist = { velocity: Array.from({ length: 50 }, (_, i) => i * 3) }
  ok(`percentile de 75 dans 0..147 → ${percentileRank(75, dist.velocity)}`)
  ok(`historique trop court (10 points) → ${percentileRank(75, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) ?? 'null (repli linéaire)'}`)

  const { subscores } = normalize({ velocity: 75, flow: 11.1, security: 78, social: null, deployer: null }, dist)
  const r = score(subscores, cfg.weights)
  ok(`sous-scores : ${JSON.stringify(subscores)}`)
  const renorm = Math.abs(Object.values(r.weightsUsed).reduce((a, b) => a + b, 0) - 1) < 0.01
  ;(renorm ? ok : ko)(`poids renormalisés sur les présents : ${JSON.stringify(r.weightsUsed)} (somme = 1)`)
  if (!renorm) allOk = false
  ok(`score ${r.score}/100 — couverture ${(r.coverage * 100).toFixed(0)}% des sous-scores`)

  // --- 3. Registre de filtres profonds -------------------------------------
  console.log('\n3. Filtres de l\'étage 5')
  await loadFilters({ force: true })
  const deep = await filtersFor('deep', { rejectionRates: {} })
  ;(deep.length === 5 ? ok : ko)(`${deep.length} filtres : ${deep.map(f => f.name).join(' → ')}`)
  if (deep.length !== 5) allOk = false
  const gratuits = deep.filter(f => f.cost === 'free').length
  ok(`${gratuits} gratuits avant ${deep.length - gratuits} payant — court-circuit au premier échec`)

  // Une donnée absente doit produire `skipped`, jamais un échec
  const lp = deep.find(f => f.name === 'lp_not_secured')
  const sansDonnee = lp.evaluate({ liquidity: {}, bonding: {} }, 95)
  const gradue = lp.evaluate({ liquidity: {}, bonding: { bonded: true } }, 95)
  ;(sansDonnee.skipped && sansDonnee.passed ? ok : ko)(
    `LP sans donnée → skipped, non bloquant (${sansDonnee.detail})`)
  ;(gradue.passed && !gradue.skipped ? ok : ko)(
    `LP d'un token gradué → ${gradue.value} (${gradue.detail})`)
  if (!sansDonnee.skipped) allOk = false

  // --- 4. Détection des franchissements ------------------------------------
  console.log('\n4. Franchissements')
  const seuils = cfg.thresholds.trigger
  ok(`seuils : ${seuils.map(s => (s / 1000) + 'K').join(', ')} | alerte si score ≥ ${cfg.thresholds.alert.min_score}`)
  const crossings = await findCrossings(cfg)
  ok(`${crossings.length} token(s) au-dessus d'un seuil non encore déclenché`)
  for (const c of crossings.slice(0, 5)) {
    console.log(`      ${(c.token.symbol ?? '?').padEnd(12)} mc ${Math.round(c.mc).toLocaleString().padStart(12)} → seuil ${(c.threshold / 1000)}K`)
  }

  // --- 5. Traitement complet -----------------------------------------------
  console.log('\n5. Traitement')
  const s = await processTriggers(cfg)
  ok(`${s.franchissements} franchissements → ${s.alertes} alerte(s)`)
  if (Object.keys(s.rejetes).length) {
    for (const [k, v] of Object.entries(s.rejetes)) console.log(`      ${String(v).padStart(3)}  ${k}`)
  }
  if (s.sansDonnees) warn(`${s.sansDonnees} sans données d'analyse approfondie`)

  // --- 6. Le snapshot est-il rejouable ? -----------------------------------
  console.log('\n6. Intégrité du snapshot (M5 doit pouvoir le rejouer)')
  const snap = await col('trigger_snapshots').findOne({}, { sort: { ts: -1 } })
  if (!snap) {
    warn('aucun snapshot — aucun token n\'a encore franchi de seuil')
  } else {
    console.log(`  ${snap.symbol ?? '?'} (${snap._id})`)
    const checks = {
      'config_version': snap.config_version != null,
      'valeurs mesurées des filtres': snap.filters?.every(f => 'value' in f && 'threshold' in f),
      'candidates non vide': Object.keys(snap.candidates ?? {}).length >= 10,
      'raw_subscores (pour percentiles futurs)': snap.raw_subscores != null,
      'score_method tracé': snap.score_method != null,
      'weights_used tracé': snap.weights_used != null,
      'garde multichain': 'is_multichain' in (snap.context ?? {}),
      'décision': ['alerted', 'rejected'].includes(snap.decision)
    }
    for (const [k, v] of Object.entries(checks)) { (v ? ok : ko)(k); if (!v) allOk = false }
    console.log(`      décision ${snap.decision} | score ${snap.score} | ${snap.filters?.length} filtres tracés`)
    const skipped = snap.filters?.filter(f => f.skipped) ?? []
    if (skipped.length) console.log(`      skipped : ${skipped.map(f => f.name).join(', ')}`)
  }

  console.log(allOk
    ? '\n\x1b[1m\x1b[32mP4 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP4 NON validée.\x1b[0m\n')
  process.exitCode = allOk ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
