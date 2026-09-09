/**
 * Commandes Telegram.
 *
 * Lecture seule, sauf `/pause`, `/seuils` et la mise en sourdine — les seules
 * écritures autorisées depuis le bot. Tout ajustement de seuil passe par
 * `createVersion()` : il est donc versionné et tracé, jamais appliqué en place.
 */

import { col } from '../core/db/client.js'
import { active, createVersion } from '../core/config/store.js'
import { getNotifier, muteToken } from '../pipeline/stages/dispatch.js'
import { esc, usd, age } from '../adapters/notifiers/telegram.js'
import * as health from '../repos/health.js'
import * as outcomesRepo from '../repos/outcomes.js'
import { mod } from '../core/logger.js'

const log = mod('bot')

const HELP = `*Commandes*

/watchlist — tokens sous surveillance rapprochée
/why <ticker> — pourquoi ce token a été alerté ou rejeté
/stats — entonnoir du jour et santé du pipeline
/seuils — configuration active
/pause — suspend les envois \\(le pipeline continue de collecter\\)
/resume — reprend les envois
/help — cette aide`

async function watchlist() {
  const tokens = await col('tokens').find(
    { status: { $in: ['tracked', 'alerted'] } },
    { projection: { symbol: 1, chain: 1, 'market.mc': 1, tier: 1, velocity: 1 } }
  ).sort({ 'market.mc': -1 }).limit(15).toArray()

  if (!tokens.length) return 'Aucun token en surveillance rapprochée.'

  const lignes = tokens.map(t => {
    const w = t.velocity?.['5min']
    const score = w?.buyers != null && w?.sellers != null ? w.buyers - w.sellers : null
    return `\`${esc((t.symbol ?? '?').padEnd(10).slice(0, 10))}\` ${esc(usd(t.market?.mc))}` +
      ` · ${esc(t.tier ?? '?')} · ${score !== null ? esc((score > 0 ? '+' : '') + score) : '—'}/5min`
  })
  return `*Surveillance* \\(${tokens.length}\\)\n\n${lignes.join('\n')}`
}

async function why(ticker) {
  if (!ticker) return 'Usage : `/why <ticker>`'

  const token = await col('tokens').findOne({ symbol: new RegExp(`^\\$?${ticker}$`, 'i') })
  if (!token) return `Aucun token nommé \`${esc(ticker)}\` en base\\.`

  const snap = await col('trigger_snapshots')
    .find({ token: token._id }).sort({ ts: -1 }).limit(1).next()

  if (!snap) {
    const rejet = await col('rejected_seen').findOne({ _id: token._id })
    if (rejet) {
      return `*${esc(token.symbol)}* — rejeté à l'admission\n\n` +
        `Motif : \`${esc(rejet.reason)}\`\n` +
        `Valeur mesurée : ${esc(rejet.value)} \\(seuil ${esc(rejet.threshold)}\\)`
    }
    return `*${esc(token.symbol)}* est suivi \\(${esc(token.status)}\\) mais n'a franchi aucun seuil\\.\n` +
      `MC actuel : ${esc(usd(token.market?.mc))}`
  }

  const lignes = (snap.filters ?? []).map(f =>
    `${f.passed ? '✅' : '❌'}${f.skipped ? '⚠️' : ''} \`${esc(f.name.padEnd(15))}\` ` +
    `${esc(f.value)} ${f.threshold != null ? `\\(seuil ${esc(f.threshold)}\\)` : ''}`)

  const out = await col('outcomes').findOne({ _id: snap._id })

  return `*${esc(snap.symbol)}* — seuil ${esc(usd(snap.threshold))} — ` +
    `${snap.decision === 'alerted' ? '🚨 alerté' : '🚫 rejeté'}\n\n` +
    `${lignes.join('\n')}\n\n` +
    `Score *${esc(snap.score)}/100* ` +
    `${snap.rejection_reason ? `— rejeté sur \`${esc(snap.rejection_reason)}\`` : ''}\n` +
    (out ? `\nDepuis : ${esc(out.multiple_max)}× · verdict ${esc(out.verdict)}` : '')
}

async function stats() {
  const [f, h, o] = await Promise.all([
    health.funnel(), health.health(), outcomesRepo.stats({ days: 30 })
  ])
  const c = f?.counts ?? {}

  const verdicts = o.length
    ? o.map(x => `${esc(x.verdict)} ${x.n}`).join(' · ')
    : 'aucun verdict rendu'

  return `*Entonnoir du jour* \\(${f?.cycles ?? 0} cycles\\)\n\n` +
    `vus ${esc(c.vus ?? 0)} → nouveaux ${esc(c.nouveaux ?? 0)} → admis ${esc(c.admis ?? 0)}\n` +
    `promus ${esc(c.promus ?? 0)} → franchissements ${esc(c.franchissements ?? 0)} → alertes ${esc(c.alertes ?? 0)}\n\n` +
    `*Verdicts \\(30j\\)* : ${verdicts}\n\n` +
    `*Pipeline* : ${h.alive ? '🟢 vivant' : '🔴 silencieux'} · ` +
    `${esc(h.silenceMinutes)} min · ${esc(h.cycles)} cycles` +
    (h.permanentLoss ? `\n\n⚠️ _Plus de 3 h de silence : les tokens lancés pendant l'arrêt sont hors de portée de Pulse\\._` : '')
}

async function seuils() {
  const cfg = await active()
  const t = cfg.thresholds
  return `*Configuration v${esc(cfg._id)}*\n\n` +
    `Mode : ${cfg.features.alerts.enabled ? '🚨 alertes actives' : '🔇 calibration'}\n` +
    `Chaînes : ${esc(Object.entries(cfg.features.chains).filter(([, v]) => v).map(([k]) => k).join(', '))}\n\n` +
    `Admission : liquidité ≥ ${esc(t.admission.min_liquidity_usd)}\\$ · ` +
    `${esc(t.admission.min_tx_15m)} tx / ${esc(t.admission.min_wallets_15m)} wallets\n` +
    `Seuils : ${esc(t.trigger.map(x => usd(x)).join(', '))}\n` +
    `Filtres : achats/ventes ≥ ${esc(t.filters.sell_pressure)} · ` +
    `wash \\< ${esc(t.filters.wash_index)} · top10 \\< ${esc(t.filters.top_holders)}%\n` +
    `Alerte : score ≥ ${esc(t.alert.min_score)} · ` +
    `cooldown ${esc(t.alert.cooldown_hours)}h · max ${esc(t.alert.max_per_hour)}/h`
}

async function setAlerts(enabled) {
  const cfg = await active()
  if (cfg.features.alerts.enabled === enabled) {
    return enabled ? 'Les alertes sont déjà actives\\.' : 'Les alertes sont déjà suspendues\\.'
  }
  const v = await createVersion(
    [{ path: 'features.alerts.enabled', to: enabled, source: 'telegram' }],
    { createdBy: 'telegram', note: enabled ? 'Reprise des envois' : 'Suspension des envois' })
  return enabled
    ? `🚨 Alertes reprises \\(config v${esc(v._id)}\\)\\.`
    : `🔇 Envois suspendus \\(config v${esc(v._id)}\\)\\. Le pipeline continue de collecter\\.`
}

// ---------------------------------------------------------------------------

export async function handleUpdate(update) {
  const notif = getNotifier()

  // Bouton « Ignorer ce token »
  if (update.callback_query) {
    const q = update.callback_query
    const [action, tokenId] = String(q.data ?? '').split(/:(.+)/)
    if (action === 'mute' && tokenId) {
      await muteToken(tokenId, true)
      await notif.answerCallback(q.id, 'Token ignoré — plus d\'alerte pour celui-ci.')
      log.info({ token: tokenId }, 'token mis en sourdine')
    }
    return
  }

  const text = update.message?.text
  const chatId = update.message?.chat?.id
  if (!text || !chatId) return

  const [raw, ...args] = text.trim().split(/\s+/)
  const cmd = raw.replace(/@.*$/, '').toLowerCase()

  const handlers = {
    '/start': () => HELP,
    '/help': () => HELP,
    '/watchlist': watchlist,
    '/why': () => why(args[0]),
    '/stats': stats,
    '/seuils': seuils,
    '/pause': () => setAlerts(false),
    '/resume': () => setAlerts(true)
  }

  const fn = handlers[cmd]
  if (!fn) return

  try {
    const reply = await fn()
    await notif.sendText(reply, { chatId, markdown: true })
  } catch (e) {
    log.error({ cmd, err: e.message }, 'commande en échec')
    await notif.sendText(`Erreur : ${e.message}`, { chatId }).catch(() => {})
  }
}

export const COMMANDS = ['/watchlist', '/why', '/stats', '/seuils', '/pause', '/resume', '/help']
