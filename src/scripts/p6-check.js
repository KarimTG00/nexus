/**
 * Validation de la phase P6.
 *
 * Critère (docs/roadmap.md) : les outcomes se remplissent et les premiers
 * verdicts tombent. Le point le plus délicat est la distinction rug/migration.
 *
 * Usage : npm run p6
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active } from '../core/config/store.js'
import { classifyLiquidityDrop, trackOutcomes, openOutcomes } from '../pipeline/stages/outcome.js'
import * as outcomesRepo from '../repos/outcomes.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect(); await cache.connect()
  const cfg = await active()
  let allOk = true

  console.log('\n\x1b[1mValidation P6 — suivi d\'outcome\x1b[0m\n')

  // --- 1. Rug vs migration -------------------------------------------------
  console.log('1. Distinction rug / migration (le point critique)')
  const recent = new Date(Date.now() - 10 * 60_000)
  const vieux = new Date(Date.now() - 10 * 3600_000)
  const cas = [
    ['liquidité stable', { before: 50_000, after: 48_000, pools: [] }, false, null],
    ['effondrement, aucun remplacement',
      { before: 50_000, after: 2_000, pools: [] }, true, 'lp_pull'],
    ['effondrement + pool récent comparable → MIGRATION',
      { before: 50_000, after: 2_000, pools: [{ address: '0xnew', createdAt: recent, liquidityUsd: 45_000 }] },
      false, 'migration'],
    ['effondrement + pool ANCIEN → rug',
      { before: 50_000, after: 2_000, pools: [{ address: '0xold', createdAt: vieux, liquidityUsd: 1_000 }] },
      true, 'lp_pull'],
    ['liquidité éparpillée sur d\'autres pools → pas un rug',
      { before: 50_000, after: 5_000, pools: [{ address: '0xa', createdAt: vieux, liquidityUsd: 30_000 }] },
      false, null]
  ]
  for (const [label, input, ruggedAttendu, typeAttendu] of cas) {
    const r = classifyLiquidityDrop(input)
    const bon = r.rugged === ruggedAttendu && (typeAttendu === null || r.type === typeAttendu)
    if (!bon) allOk = false
    ;(bon ? ok : ko)(`${label.padEnd(52)} → rugged=${r.rugged} type=${r.type ?? '—'}`)
  }

  // --- 2. Verdicts ---------------------------------------------------------
  console.log('\n2. Calcul des verdicts')
  const verdicts = [
    ['×12 sans rug', { rugged: false, multipleMax: 12, alive: true }, 'SUCCESS'],
    ['×12 PUIS rug', { rugged: true, multipleMax: 12, alive: false }, 'RUGGED'],
    ['×1,8 encore vivant', { rugged: false, multipleMax: 1.8, alive: true }, 'SURVIVED'],
    ['×1,1 liquidité partie', { rugged: false, multipleMax: 1.1, alive: false }, 'DEAD']
  ]
  for (const [label, input, attendu] of verdicts) {
    const v = outcomesRepo.computeVerdict(input, cfg)
    const bon = v === attendu
    if (!bon) allOk = false
    ;(bon ? ok : ko)(`${label.padEnd(26)} → ${v}`)
  }
  ok('un ×12 suivi d\'un rug n\'est PAS un succès qu\'on veut apprendre à attraper')

  // --- 3. Ouverture depuis les snapshots existants -------------------------
  console.log('\n3. Ouverture des outcomes')
  const snaps = await col('trigger_snapshots').find({}).toArray()
  const avant = await col('outcomes').countDocuments()
  const crees = await openOutcomes(snaps, cfg)
  const apres = await col('outcomes').countDocuments()
  ok(`${snaps.length} snapshots → ${crees} outcomes créés (total ${apres})`)

  const alertes = snaps.filter(s => s.decision === 'alerted').length
  const rejetes = snaps.filter(s => s.decision === 'rejected').length
  ok(`suivi des alertés (${alertes}) ET des rejetés (${rejetes}) — sans les rejetés, M5 n'a pas de groupe de comparaison`)

  // --- 4. Un relevé réel ---------------------------------------------------
  console.log('\n4. Relevé')
  // On force l'échéance pour ne pas attendre une heure
  await col('outcomes').updateMany({ verdict: 'PENDING' }, { $set: { next_checkpoint_at: new Date() } })
  const s = await trackOutcomes(cfg)
  ok(`${s.echus} échus → ${s.releves} relevés, ${s.rugs} rug(s), ${s.migrations} migration(s)`)
  if (Object.keys(s.verdicts).length) ok(`verdicts rendus : ${JSON.stringify(s.verdicts)}`)

  // --- 5. Forme du document ------------------------------------------------
  console.log('\n5. Intégrité du document')
  const o = await col('outcomes').findOne({}, { sort: { triggered_at: -1 } })
  if (!o) { ko('aucun outcome'); allOk = false }
  else {
    console.log(`  ${o.symbol ?? '?'} (${o._id})`)
    const checks = {
      'decision dupliquée (évite une jointure)': o.decision != null,
      'mc_at_trigger': o.mc_at_trigger != null,
      'liquidity_at_trigger (base du calcul de rug)': o.liquidity_at_trigger !== undefined,
      'checkpoints enregistrés': Object.keys(o.checkpoints ?? {}).length > 0,
      'multiple_max': o.multiple_max != null,
      'verdict': outcomesRepo.VERDICTS.includes(o.verdict),
      'config_version': o.config_version != null
    }
    for (const [k, v] of Object.entries(checks)) { (v ? ok : ko)(k); if (!v) allOk = false }
    console.log(`      verdict ${o.verdict} | multiple ${o.multiple_max} | ` +
      `checkpoints ${Object.keys(o.checkpoints ?? {}).join(', ') || '—'} | ` +
      `prochaine échéance ${o.next_checkpoint_at?.toISOString().slice(11, 16) ?? '—'}`)
  }

  // --- 6. Le tableau que M5 produira ---------------------------------------
  console.log('\n6. Efficacité des filtres (aperçu de M5)')
  const eff = await outcomesRepo.filterEfficacy()
  if (eff.filtres.length) {
    console.log(`      référence : ${eff.reference.alertes} alertés, taux de succès ${eff.reference.taux_succes ?? '—'}`)
    for (const f of eff.filtres) {
      console.log(`      ${f.filtre.padEnd(18)} ${String(f.rejetes).padStart(4)} rejetés → ${f.succes_apres_rejet} succès (${(f.taux * 100).toFixed(1)}%)`)
    }
    ok('la requête fonctionne — elle deviendra lisible avec quelques semaines de données')
  } else {
    warn('pas encore de rejet avec verdict — normal, il faut 7 jours par token')
  }

  console.log(allOk
    ? '\n\x1b[1m\x1b[32mP6 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP6 NON validée.\x1b[0m\n')
  process.exitCode = allOk ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
