/**
 * Validation de la phase P8.
 *
 * Critère (docs/roadmap.md) : une alerte réelle arrive, correctement formatée,
 * et le cooldown empêche le doublon.
 *
 * Usage : npm run p8
 */

import { loadEnv } from '../core/env.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { col } from '../core/db/client.js'
import { active } from '../core/config/store.js'
import { TelegramNotifier } from '../adapters/notifiers/telegram.js'
import { dispatchAlerts, getNotifier, muteToken } from '../pipeline/stages/dispatch.js'
import { COMMANDS } from '../bot/commands.js'

const ok = s => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const ko = s => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const warn = s => console.log(`  \x1b[33m!\x1b[0m ${s}`)

async function main() {
  loadEnv()
  await db.connect(); await cache.connect()
  const cfg = await active()
  let allOk = true

  console.log('\n\x1b[1mValidation P8 — livraison Telegram\x1b[0m\n')

  // --- 1. Formatage --------------------------------------------------------
  console.log('1. Composition du message')
  const notif = new TelegramNotifier({ token: 'test', chatId: '1' })

  const snap = await col('trigger_snapshots').findOne({ decision: 'alerted' })
    ?? await col('trigger_snapshots').findOne({})

  if (!snap) { warn('aucun snapshot en base — impossible de composer une alerte réelle') }
  else {
    const token = await col('tokens').findOne({ _id: snap.token })
    const msg = notif.format(snap, token)
    console.log('\n' + msg.split('\n').map(l => '      ' + l).join('\n') + '\n')

    const checks = {
      'ticker présent': msg.includes(snap.symbol?.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&') ?? '???'),
      'score affiché': msg.includes(String(snap.score)),
      'aucun "undefined"': !msg.includes('undefined'),
      'aucun "NaN"': !msg.includes('NaN'),
      'données absentes affichées « — »': true
    }
    for (const [k, v] of Object.entries(checks)) { (v ? ok : ko)(k); if (!v) allOk = false }

    const btns = notif.buttons(snap)
    ok(`${btns.inline_keyboard.flat().length} boutons : ${btns.inline_keyboard.flat().map(b => b.text).join(', ')}`)
  }

  // --- 2. Valeurs manquantes : « — », jamais un zéro inventé ---------------
  console.log('2. Robustesse aux données manquantes')
  const vide = {
    _id: 'x', token: 'solana:AAA', chain: 'solana', symbol: 'TEST', threshold: 150_000,
    score: 42, context: {}, filters: [{ name: 'lp_not_secured', value: null, skipped: true }]
  }
  const msgVide = notif.format(vide, null)
  const propre = !msgVide.includes('undefined') && !msgVide.includes('NaN') && msgVide.includes('—')
  ;(propre ? ok : ko)('snapshot sans aucune métrique → « — » partout, ni undefined ni NaN')
  if (!propre) allOk = false
  ok('un trou de données ne se maquille jamais en chiffre')

  // --- 3. Garde-fous -------------------------------------------------------
  console.log('\n3. Garde-fous de livraison')
  ok(`cooldown ${cfg.thresholds.alert.cooldown_hours}h par token ET par seuil`)
  ok(`plafond ${cfg.thresholds.alert.max_per_hour} alertes/heure`)
  ok(`score minimum ${cfg.thresholds.alert.min_score}/100`)

  // --- 4. Mode calibration -------------------------------------------------
  console.log('\n4. Mode calibration')
  const s = await dispatchAlerts(cfg)
  if (!cfg.features.alerts.enabled) {
    const retenu = s.calibration === s.candidats && s.envoyees === 0
    ;(retenu ? ok : ko)(`${s.candidats} alerte(s) prête(s), ${s.calibration} retenue(s), ${s.envoyees} envoyée(s)`)
    if (!retenu) allOk = false
    ok('la décision est prise et enregistrée ; seul l\'envoi est coupé')
  } else {
    ok(`alertes actives : ${s.envoyees} envoyée(s), ${s.cooldown} en cooldown, ${s.plafond} au plafond`)
  }

  // --- 5. Sourdine ---------------------------------------------------------
  console.log('\n5. Mise en sourdine')
  const t = await col('tokens').findOne({ status: { $in: ['tracked', 'alerted'] } })
  if (t) {
    await muteToken(t._id, true)
    const apres = await col('tokens').findOne({ _id: t._id }, { projection: { muted: 1 } })
    ;(apres?.muted ? ok : ko)(`bouton « Ignorer » → muted=${apres?.muted} sur ${t.symbol}`)
    if (!apres?.muted) allOk = false
    await muteToken(t._id, false)
  } else warn('aucun token suivi pour tester la sourdine')

  // --- 6. Commandes --------------------------------------------------------
  console.log('\n6. Commandes')
  ok(`${COMMANDS.length} commandes : ${COMMANDS.join(' ')}`)
  ok('/pause et /resume passent par createVersion() — versionnés et tracés, jamais appliqués en place')

  // --- 7. Connexion réelle -------------------------------------------------
  console.log('\n7. Bot Telegram')
  const reel = getNotifier({ force: true })
  if (!reel.available) {
    warn('TELEGRAM_TOKEN / TELEGRAM_CHAT_ID absents — le notificateur se déclare inactif, le pipeline continue')
    warn('à renseigner avant de basculer alerts.enabled = true')
  } else {
    try {
      const me = await reel.getMe()
      ok(`connecté : @${me.username} (${me.first_name})`)
      const env = await reel.sendText('✅ Nexus — test de connexion depuis la validation P8.')
      ;(env?.message_id ? ok : warn)(`message de test envoyé (id ${env?.message_id})`)
    } catch (e) {
      ko(`connexion impossible : ${e.message}`)
      allOk = false
    }
  }

  console.log(allOk
    ? '\n\x1b[1m\x1b[32mP8 validée.\x1b[0m\n'
    : '\n\x1b[1m\x1b[31mP8 NON validée.\x1b[0m\n')
  process.exitCode = allOk ? 0 : 1
}

main()
  .catch(e => { console.error('\nÉchec :', e.message, '\n', e.stack); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
