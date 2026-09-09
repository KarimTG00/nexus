/**
 * Validation de la phase P5.
 *
 * Critère (docs/roadmap.md) : le pipeline tourne sans intervention.
 * Ce script lance quelques cycles réels et vérifie l'orchestration.
 *
 * Usage : npm run p5
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active } from '../core/config/store.js'
import { Scheduler } from '../core/scheduler.js'
import * as health from '../repos/health.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect(); await cache.connect()
  const cfg = await active()
  let allOk = true

  console.log('\n\x1b[1mValidation P5 — orchestration et mode calibration\x1b[0m\n')

  // --- 1. Mode calibration -------------------------------------------------
  console.log('1. Mode de fonctionnement')
  const calibration = !cfg.features.alerts.enabled
  ;(calibration ? ok : warn)(calibration
    ? 'calibration : le pipeline évalue tout et n\'envoie rien'
    : 'ALERTES ACTIVES')
  ok(`chaînes : ${Object.entries(cfg.features.chains).filter(([, v]) => v).map(([k]) => k).join(', ')}`)
  ok(`cycle toutes les ${cfg.sources.discovery_interval_min} min`)

  // --- 2. Cadence fixe ------------------------------------------------------
  console.log('\n2. Cadence de l\'ordonnanceur')
  const sched = new Scheduler()
  const debuts = []
  sched.every('lent', 400, async () => { debuts.push(Date.now()); await new Promise(r => setTimeout(r, 250)) })
  await new Promise(r => setTimeout(r, 2100))
  await sched.stop()
  const st = sched.status()[0]
  const ecarts = debuts.slice(1).map((t, i) => t - debuts[i])
  const moyenne = ecarts.length ? ecarts.reduce((a, b) => a + b, 0) / ecarts.length : 0

  // Une tâche de 250 ms planifiée toutes les 400 ms doit DÉMARRER toutes les
  // 400 ms — pas toutes les 650. Replanifier depuis la fin du cycle ferait
  // dériver le rythme d'autant que le traitement dure.
  const stable = Math.abs(moyenne - 400) < 90
  ;(stable ? ok : ko)(`tâche de 250 ms toutes les 400 ms → écart moyen ${moyenne.toFixed(0)} ms (attendu ~400)`)
  if (!stable) allOk = false
  ok(`${st.runs} exécutions, ${st.overruns} dépassements, ${st.errors} erreurs`)

  // --- 3. Isolation des étages --------------------------------------------
  console.log('\n3. Isolation des étages')
  const r = await Scheduler.runStages({
    a: async () => ({ n: 1 }),
    b: async () => { throw new Error('panne simulée') },
    c: async () => ({ n: 3 })
  })
  const isole = r.a?.n === 1 && r.b?.error && r.c?.n === 3
  ;(isole ? ok : ko)(`un étage en panne n'arrête pas les suivants : ${JSON.stringify(r)}`)
  if (!isole) allOk = false

  // --- 4. Cycles réels -----------------------------------------------------
  console.log('\n4. Deux cycles réels')
  const { discover } = await import('../pipeline/stages/discovery.js')
  const { admit, checkActivity } = await import('../pipeline/stages/admission.js')
  const { monitor } = await import('../pipeline/stages/monitoring.js')
  const { processTriggers } = await import('../pipeline/stages/trigger.js')
  const { getSource } = await import('../adapters/sources/index.js')
  const src = getSource(cfg)

  for (let i = 1; i <= 2; i++) {
    const t0 = Date.now()
    const c0 = (await src.stats()).primary?.used ?? 0
    let candidates = []
    const stats = await Scheduler.runStages({
      discovery: async () => { const d = await discover(cfg); candidates = d.candidates; return d.stats },
      admission: () => admit(candidates, cfg),
      activity: () => checkActivity(cfg),
      monitoring: () => monitor(cfg),
      triggers: () => processTriggers(cfg)
    })
    const dur = Date.now() - t0
    const c1 = (await src.stats()).primary?.used ?? 0
    await health.beat({ cycle: i, stats, durationMs: dur, configVersion: cfg._id })
    await health.accumulateFunnel(stats)

    const err = Object.entries(stats).filter(([, v]) => v?.error)
    ;(err.length === 0 ? ok : ko)(
      `cycle ${i} : ${(dur / 1000).toFixed(0)}s, ${c1 - c0} crédits — ` +
      `vus ${stats.discovery?.vus ?? '?'}, admis ${stats.admission?.admis ?? '?'}, ` +
      `promus ${stats.activity?.promus ?? '?'}, surveillés ${stats.monitoring?.releves ?? '?'}, ` +
      `franchissements ${stats.triggers?.franchissements ?? '?'}`)
    for (const [k, v] of err) { ko(`  étage ${k} : ${v.error}`); allOk = false }
  }

  // --- 5. Battement de cœur ------------------------------------------------
  console.log('\n5. Supervision')
  const h = await health.health()
  ;(h.alive ? ok : ko)(`pipeline vivant — silence ${h.silenceMinutes} min, ${h.cycles} cycles enregistrés`)
  if (!h.alive) allOk = false
  ok(`détection de perte définitive au-delà de 180 min de silence : ${h.permanentLoss ? 'DÉCLENCHÉE' : 'non'}`)

  // --- 6. Entonnoir du jour ------------------------------------------------
  console.log('\n6. Entonnoir cumulé')
  const f = await health.funnel()
  if (f) {
    const c = f.counts ?? {}
    ok(`${f.cycles} cycles cumulés aujourd'hui`)
    console.log(`      vus ${c.vus} → nouveaux ${c.nouveaux} → admis ${c.admis} → promus ${c.promus}`)
    console.log(`      surveillés ${c.surveilles} → franchissements ${c.franchissements} → alertes ${c.alertes}`)
    if (f.rejets_admission) console.log(`      rejets admission : ${JSON.stringify(f.rejets_admission)}`)
    if (f.rejets_declenchement) console.log(`      rejets déclenchement : ${JSON.stringify(f.rejets_declenchement)}`)
  } else { ko('aucun entonnoir enregistré'); allOk = false }

  // --- 7. Démarrage réel des workers ---------------------------------------
  // Les sections précédentes importent les étages directement. Elles ne
  // touchent JAMAIS les points d'entrée — c'est ainsi qu'un `cache is not a
  // function` dans workers/pipeline.js est passé entre les mailles et n'a
  // planté qu'au déploiement. On lance donc les vrais processus.
  console.log('\n7. Démarrage réel des points d\'entrée')
  const { spawn } = await import('node:child_process')

  const demarre = (script, attendu, ms = 25_000) => new Promise(resolve => {
    const p = spawn(process.execPath, ['--env-file=.env', script], {
      env: { ...process.env, LOG_LEVEL: 'info' }
    })
    let sortie = ''
    let fini = false
    const done = r => { if (fini) return; fini = true; p.kill('SIGTERM'); resolve(r) }

    const lire = d => {
      sortie += d.toString()
      if (/démarrage impossible|TypeError|ReferenceError/i.test(sortie)) {
        const m = sortie.match(/"?(?:err|message)"?:\s*"([^"]+)"/)
        done({ ok: false, err: m?.[1] ?? 'erreur au démarrage' })
      } else if (attendu.test(sortie)) done({ ok: true })
    }
    p.stdout.on('data', lire)
    p.stderr.on('data', lire)
    p.on('exit', code => done({ ok: false, err: `sorti en code ${code}` }))
    setTimeout(() => done({ ok: false, err: 'aucun signe de vie' }), ms)
  })

  for (const [script, motif, label] of [
    ['src/workers/pipeline.js', /tâche planifiée|démarrage du pipeline/, 'worker pipeline'],
    ['src/workers/api.js', /service web démarré/, 'service web']
  ]) {
    const r = await demarre(script, motif)
    ;(r.ok ? ok : ko)(`${label.padEnd(16)} ${r.ok ? 'démarre' : 'ÉCHEC : ' + r.err}`)
    if (!r.ok) allOk = false
  }

  // --- 8. Fichiers de déploiement -----------------------------------------
  console.log('\n8. Déploiement Railway')
  const { existsSync, readFileSync } = await import('node:fs')
  for (const file of ['Dockerfile', 'railway.json', '.dockerignore']) {
    ;(existsSync(file) ? ok : ko)(file)
    if (!existsSync(file)) allOk = false
  }
  const ignore = existsSync('.dockerignore') ? readFileSync('.dockerignore', 'utf8') : ''
  ;(ignore.includes('.env') ? ok : ko)('.env exclu de l\'image')
  if (!ignore.includes('.env')) allOk = false

  console.log(allOk
    ? '\n\x1b[1m\x1b[32mP5 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP5 NON validée.\x1b[0m\n')
  process.exitCode = allOk ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
