/**
 * Worker principal — enchaîne les étages de la face 1, en continu.
 *
 * En mode calibration (`alerts.enabled: false`), le pipeline tourne
 * intégralement et écrit tous les `trigger_snapshots` — il n'envoie
 * simplement rien. Aucun code spécifique : c'est un drapeau de configuration.
 *
 * Pourquoi la continuité est critique : la fenêtre Pulse ne remonte qu'à ~3 h
 * et n'offre aucun rattrapage. Chaque heure d'arrêt est une perte définitive.
 */

import { loadEnv } from '../core/env.js'
import { logger, mod } from '../core/logger.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { active } from '../core/config/store.js'
import { Scheduler } from '../core/scheduler.js'
import { getSource } from '../adapters/sources/index.js'

import { discover } from '../pipeline/stages/discovery.js'
import { admit, checkActivity } from '../pipeline/stages/admission.js'
import { monitor } from '../pipeline/stages/monitoring.js'
import { processTriggers } from '../pipeline/stages/trigger.js'
import { trackOutcomes } from '../pipeline/stages/outcome.js'
import * as health from '../repos/health.js'

const log = mod('worker')

let cycleNum = 0

/**
 * Un cycle complet. Les étages sont isolés : celui qui tombe n'emporte pas
 * les suivants — notamment parce que la découverte parcourt les chaînes dans
 * l'ordre, et qu'un incident sur la première priverait les dernières.
 */
async function runCycle() {
  const t0 = Date.now()
  const cycle = ++cycleNum
  const cfg = await active()

  let candidates = []
  const stats = await Scheduler.runStages({
    discovery: async () => {
      const r = await discover(cfg)
      candidates = r.candidates
      return r.stats
    },
    admission: () => admit(candidates, cfg),
    activity: () => checkActivity(cfg),
    monitoring: () => monitor(cfg),
    triggers: () => processTriggers(cfg),
    outcomes: () => trackOutcomes(cfg)
  })

  const durationMs = Date.now() - t0
  await health.beat({ cycle, stats, durationMs, configVersion: cfg._id })
  await health.accumulateFunnel(stats)

  const src = getSource(cfg)
  const s = await src.stats()
  const credits = s.primary?.used ?? s.used ?? 0

  log.info({
    cycle,
    duree_s: +(durationMs / 1000).toFixed(1),
    vus: stats.discovery?.vus,
    admis: stats.admission?.admis,
    promus: stats.activity?.promus,
    surveilles: stats.monitoring?.releves,
    franchissements: stats.triggers?.franchissements,
    alertes: stats.triggers?.alertes,
    credits
  }, 'cycle terminé')

  return stats
}

/** Rapport quotidien du mode calibration : où le flux s'étrangle. */
async function dailyReport() {
  const f = await health.funnel()
  if (!f) return
  const c = f.counts ?? {}
  log.info({
    periode: f.period,
    cycles: f.cycles,
    vus: c.vus, nouveaux: c.nouveaux, admis: c.admis,
    promus: c.promus, franchissements: c.franchissements, alertes: c.alertes,
    rejets_admission: f.rejets_admission,
    rejets_declenchement: f.rejets_declenchement
  }, 'entonnoir du jour')
}

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()
  const cfg = await active()

  if (!cache().shared) {
    log.warn('cache non partagé (REDIS_URL absent) — acceptable en mono-processus, '
      + 'à corriger avant d\'ajouter le collecteur de swaps')
  }

  log.info({
    version_config: cfg._id,
    chaines: Object.entries(cfg.features.chains).filter(([, v]) => v).map(([k]) => k),
    mode: cfg.features.alerts.enabled ? 'ALERTES ACTIVES' : 'calibration (aucun envoi)',
    intervalle_min: cfg.sources.discovery_interval_min
  }, 'démarrage du pipeline')

  const scheduler = new Scheduler()
  scheduler.every('cycle', cfg.sources.discovery_interval_min * 60_000, runCycle)
  scheduler.every('rapport', 6 * 3600_000, dailyReport, { runOnStart: false })

  const shutdown = async signal => {
    log.info({ signal }, 'arrêt demandé')
    await scheduler.stop()
    await db.close()
    await cache.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Un plantage non capturé tuerait le worker en silence : on le trace avant
  // de laisser l'orchestrateur redémarrer le service.
  process.on('unhandledRejection', e => {
    logger.error({ err: e?.message, stack: e?.stack }, 'rejet non capturé')
  })
}

main().catch(e => {
  logger.error({ err: e.message, stack: e.stack }, 'démarrage impossible')
  process.exit(1)
})
