/**
 * ÉTAGE 7 — Livraison des alertes.
 *
 * Le pipeline décide (étage 6), cet étage envoie. La séparation compte : en
 * mode calibration tout est décidé et enregistré, seul l'envoi est coupé.
 * Ce qu'on mesure en calibration est donc exactement ce qui tournera ensuite.
 *
 * Trois garde-fous, dans cet ordre :
 *   1. token ignoré manuellement
 *   2. cooldown par token ET par seuil
 *   3. plafond horaire — en marché euphorique, sans lui, le canal devient
 *      illisible et l'utilisateur cesse de lire
 */

import { col } from '../../core/db/client.js'
import { TelegramNotifier } from '../../adapters/notifiers/telegram.js'
import { mod } from '../../core/logger.js'

const log = mod('stage:dispatch')

let notifier = null
export function getNotifier({ force = false } = {}) {
  if (!notifier || force) notifier = new TelegramNotifier()
  return notifier
}

/** Le token a-t-il été mis en sourdine depuis Telegram ? */
async function isMuted(tokenId) {
  const t = await col('tokens').findOne({ _id: tokenId }, { projection: { muted: 1 } })
  return Boolean(t?.muted)
}

/** Une alerte a-t-elle déjà été envoyée pour ce token et ce seuil récemment ? */
async function inCooldown(tokenId, threshold, hours) {
  const since = new Date(Date.now() - hours * 3_600_000)
  const n = await col('alerts').countDocuments({
    token: tokenId, threshold, sent_at: { $gte: since }
  })
  return n > 0
}

async function sentLastHour() {
  return col('alerts').countDocuments({ sent_at: { $gte: new Date(Date.now() - 3_600_000) } })
}

/**
 * Envoie les alertes en attente.
 * Une alerte « en attente » est un trigger_snapshot de décision `alerted`
 * qui n'a pas encore de ligne dans `alerts`.
 */
export async function dispatchAlerts(cfg, { limit = 20 } = {}) {
  const stats = { candidats: 0, envoyees: 0, muets: 0, cooldown: 0, plafond: 0,
                  echecs: 0, calibration: 0, perimes: 0 }

  const pending = await col('trigger_snapshots').aggregate([
    // `dispatch_abandoned_at` écarte les décisions dont l'envoi ne partira
    // plus jamais. Sans lui, les 11 décisions de l'ère calibration revenaient
    // à chaque cycle pour être refusées à nouveau, occupant des places sous
    // `$limit` et laissant `candidats: 11` en permanence dans l'entonnoir.
    // `source: 'stream'` : le flux temps réel envoie ses alertes lui-même, à
    // la seconde. Les reprendre ici les enverrait une seconde fois.
    { $match: { decision: 'alerted', dispatch_abandoned_at: { $exists: false }, source: { $ne: 'stream' } } },
    { $sort: { ts: -1 } },
    { $limit: limit },
    { $lookup: { from: 'alerts', localField: '_id', foreignField: 'trigger_id', as: 'sent' } },
    { $match: { sent: { $size: 0 } } }
  ]).toArray()

  stats.candidats = pending.length
  if (!pending.length) return stats

  // Mode calibration : on décide, on enregistre, on n'envoie pas.
  if (!cfg.features.alerts.enabled) {
    stats.calibration = pending.length
    log.info(stats, 'alertes retenues (mode calibration)')
    return stats
  }

  const notif = getNotifier()
  if (!notif.available) {
    log.warn('alertes activées mais notificateur indisponible — vérifier TELEGRAM_TOKEN et TELEGRAM_CHAT_ID')
    return stats
  }

  const { cooldown_hours: cooldown, max_per_hour: cap } = cfg.thresholds.alert

  // Une alerte perimee est pire qu une alerte manquee : elle invite a entrer
  // sur un mouvement termine. Le cas se presente des qu un envoi a ete
  // suspendu — panne, calibration, redeploiement — et le retard accumule
  // partirait alors d un coup.
  const maxAgeMs = (cfg.thresholds.alert.max_age_minutes ?? 30) * 60_000
  let horaire = await sentLastHour()

  for (const snap of pending.reverse()) {          // du plus ancien au plus récent
    if (Date.now() - new Date(snap.ts).getTime() > maxAgeMs) {
      // Une décision périmée ne redeviendra jamais fraîche : on la classe une
      // fois pour toutes. Le champ s'ajoute A COTE de la décision, qui reste
      // intacte — `trigger_snapshots` est un registre append-only, on n'y
      // réécrit jamais ce qui a été décidé, seulement ce qu'on en a fait.
      await col('trigger_snapshots').updateOne({ _id: snap._id }, { $set: {
        dispatch_abandoned_at: new Date(),
        dispatch_abandoned_reason: 'perimee',
        dispatch_age_minutes: Math.round((Date.now() - new Date(snap.ts).getTime()) / 60_000)
      } })
      stats.perimes++
      continue
    }
    if (horaire >= cap) { stats.plafond++; continue }
    if (await isMuted(snap.token)) { stats.muets++; continue }
    if (await inCooldown(snap.token, snap.threshold, cooldown)) { stats.cooldown++; continue }

    const token = await col('tokens').findOne({ _id: snap.token })

    try {
      const r = await notif.send(snap, token)
      await col('alerts').insertOne({
        trigger_id: snap._id,
        token: snap.token,
        chain: snap.chain,
        symbol: snap.symbol,
        threshold: snap.threshold,
        score: snap.score,
        sent_at: new Date(),
        telegram_message_id: r.messageId ?? null,
        config_version: cfg._id
      })
      stats.envoyees++
      horaire++
      log.info({ token: snap.token, symbol: snap.symbol, score: snap.score }, 'alerte envoyée')
    } catch (e) {
      stats.echecs++
      log.error({ token: snap.token, err: e.message }, 'envoi en échec')
    }
  }

  log.info(stats, 'livraison')
  return stats
}

export async function muteToken(tokenId, muted = true) {
  await col('tokens').updateOne({ _id: tokenId }, { $set: { muted, muted_at: new Date() } })
}
