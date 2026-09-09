/**
 * Battement de cœur et entonnoir quotidien.
 *
 * La supervision doit détecter un worker MORT, pas seulement des erreurs.
 * Un processus qui s'arrête en silence ne produit aucun log d'erreur — et
 * comme la fenêtre Pulse ne remonte qu'à ~3 h, chaque heure d'arrêt est une
 * perte définitive.
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('repo:health')
const HEARTBEAT_ID = 'pipeline'

export async function beat({ cycle, stats, durationMs, configVersion }) {
  await col('system_state').updateOne(
    { _id: HEARTBEAT_ID },
    {
      $set: {
        last_beat_at: new Date(),
        last_cycle: cycle,
        last_duration_ms: durationMs,
        last_stats: stats,
        config_version: configVersion,
        pid: process.pid
      },
      $inc: { cycles: 1 },
      $setOnInsert: { started_at: new Date() }
    },
    { upsert: true }
  )
}

/** Le pipeline est-il vivant ? */
export async function health({ maxSilenceMinutes = 20 } = {}) {
  const doc = await col('system_state').findOne({ _id: HEARTBEAT_ID })
  if (!doc) return { alive: false, reason: 'jamais démarré' }

  const silenceMin = (Date.now() - doc.last_beat_at.getTime()) / 60_000
  return {
    alive: silenceMin < maxSilenceMinutes,
    silenceMinutes: +silenceMin.toFixed(1),
    cycles: doc.cycles,
    lastCycle: doc.last_cycle,
    lastDurationMs: doc.last_duration_ms,
    startedAt: doc.started_at,
    // Au-delà de 3 h de silence, les tokens lancés pendant l'arrêt sont
    // définitivement hors de portée : Pulse ne les remontera plus.
    permanentLoss: silenceMin > 180
  }
}

/**
 * Entonnoir du jour — cumulé cycle après cycle.
 * C'est le rapport quotidien du mode calibration : on évalue tout, on n'envoie
 * rien, et on regarde où le flux s'étrangle.
 */
export async function accumulateFunnel(stats) {
  const period = new Date().toISOString().slice(0, 10)
  const inc = {
    'counts.vus': stats.discovery?.vus ?? 0,
    'counts.connus': stats.discovery?.connus ?? 0,
    'counts.nouveaux': stats.discovery?.nouveaux ?? 0,
    'counts.pools_ajoutes': stats.discovery?.poolsAjoutes ?? 0,
    'counts.admis': stats.admission?.admis ?? 0,
    'counts.promus': stats.activity?.promus ?? 0,
    'counts.archives': stats.activity?.archives ?? 0,
    'counts.surveilles': stats.monitoring?.releves ?? 0,
    'counts.franchissements': stats.triggers?.franchissements ?? 0,
    'counts.alertes': stats.triggers?.alertes ?? 0,
    cycles: 1
  }

  for (const [reason, n] of Object.entries(stats.admission?.rejetes ?? {})) {
    inc[`rejets_admission.${reason}`] = n
  }
  for (const [reason, n] of Object.entries(stats.triggers?.rejetes ?? {})) {
    inc[`rejets_declenchement.${reason}`] = n
  }

  await col('analytics_funnel').updateOne(
    { period },
    { $inc: inc, $set: { computed_at: new Date() }, $setOnInsert: { period } },
    { upsert: true }
  )
}

export async function funnel(period = new Date().toISOString().slice(0, 10)) {
  return col('analytics_funnel').findOne({ period })
}
