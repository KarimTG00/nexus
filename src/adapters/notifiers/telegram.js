/**
 * Notificateur Telegram.
 *
 * Appels directs à l'API Bot : cinq endpoints suffisent, une dépendance de
 * bibliothèque serait du poids sans contrepartie — même raisonnement que pour
 * le serveur HTTP natif.
 *
 * ⚠️ AUCUN APPEL LLM ICI. La structure du message est connue et les valeurs
 * sont mesurées : un modèle n'apporterait que de la latence, du coût et un
 * risque d'invention. À 150K de MC un token n'a ni site ni historique — un
 * LLM à qui on demanderait une « thèse » ne dirait pas qu'il n'a rien à lire,
 * il la fabriquerait.
 */

import { request } from '../../core/net/http.js'
import { mod } from '../../core/logger.js'

const log = mod('telegram')
const API = 'https://api.telegram.org/bot'

const EXPLORERS = {
  solana: a => `https://dexscreener.com/solana/${a}`,
  base: a => `https://dexscreener.com/base/${a}`,
  bnb: a => `https://dexscreener.com/bsc/${a}`,
  robinhood: a => `https://dexscreener.com/robinhood/${a}`
}

const CHAIN_LABEL = {
  solana: 'Solana', base: 'Base', bnb: 'BNB Chain', robinhood: 'Robinhood Chain'
}

/** Échappe les caractères réservés de MarkdownV2. */
const esc = s => String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')

/** Formate un nombre, ou « — » s'il est absent. Jamais de zéro inventé. */
const num = (v, { suffix = '', decimals = 0 } = {}) =>
  v === null || v === undefined || Number.isNaN(v)
    ? '—'
    : Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString('fr-FR').replace(/ | /g, ' ') + suffix
      : v.toFixed(decimals) + suffix

const usd = v => v === null || v === undefined ? '—'
  : v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M$'
    : v >= 1000 ? Math.round(v / 1000) + 'K$'
      : Math.round(v) + '$'

const age = minutes => {
  if (minutes === null || minutes === undefined) return '—'
  if (minutes < 60) return `${Math.round(minutes)}min`
  const h = Math.floor(minutes / 60)
  if (h < 24) return `${h}h${String(Math.round(minutes % 60)).padStart(2, '0')}`
  return `${Math.floor(h / 24)}j`
}

const arrows = direction =>
  direction === 'up' ? '↗↗↗' : direction === 'down' ? '↘↘↘' : '→'

export class TelegramNotifier {
  constructor({ token = process.env.TELEGRAM_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID } = {}) {
    this.name = 'telegram'
    this.token = token
    this.chatId = chatId
    this.available = Boolean(token && chatId)
    this.supportsButtons = true
    if (!this.available) log.warn('TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID absent — notificateur inactif')
  }

  async #call(method, body) {
    const { json } = await request(`${API}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      retries: 2
    })
    if (!json.ok) throw new Error(`Telegram ${method} : ${json.description}`)
    return json.result
  }

  /**
   * Compose l'alerte à partir du snapshot de déclenchement.
   * Toute valeur absente s'affiche « — » : on ne maquille jamais un trou de
   * données en chiffre.
   */
  format(snapshot, token) {
    const c = snapshot.context ?? {}
    const v = c.velocity ?? {}
    const filter = n => snapshot.filters?.find(f => f.name === n)
    const chain = CHAIN_LABEL[snapshot.chain] ?? snapshot.chain

    const lp = filter('lp_not_secured')
    const lpText = lp?.skipped ? 'non mesurable' : lp?.value === 'protocolaire'
      ? 'protocolaire' : lp?.value !== null && lp?.value !== undefined ? `${lp.value}%` : '—'

    const sec = token?.security ?? {}
    const secText = sec.checked === false
      ? `non contrôlée \\(${esc(sec.reason ?? '?')}\\)`
      : snapshot.chain === 'solana'
        ? `Mint ✕ · Freeze ✕`
        : `Propriété ${sec.ownership_renounced ? 'renoncée' : 'active'}`

    const dep = token?.deployer_reputation
    const depText = dep
      ? `${dep.n_launches} lancements, ${dep.n_rugged} rug`
      : 'inconnu'

    const social = snapshot.candidates?.social_score
    const socialText = social ? `${social}/100` : 'aucun réseau détecté'

    const lines = [
      `🚨 *${esc(snapshot.symbol ?? '?')}* — ${esc(chain)} · ${esc(age(c.age_minutes))}`,
      `${esc(usd(c.mc))} de MC franchi`,
      '',
      `📈 Score d'intérêt   *${esc(num(v.score))}*/5min   ${esc(arrows(v.acceleration?.direction))}`,
      `👥 ${esc(num(v.traders))} traders uniques · ${esc(num(v.buys))} achats / ${esc(num(v.sells))} ventes`,
      `💧 Liquidité ${esc(usd(c.liquidity_aggregate ?? c.liquidity_consensus))} · LP ${esc(lpText)}`,
      `🔒 ${secText} · Top10 ${esc(num(c.top10_pct, { decimals: 1, suffix: '%' }))}`,
      `👤 Déployeur : ${esc(depText)}`,
      `🌐 Social ${esc(socialText)}`,
      '',
      `*Score ${esc(snapshot.score)}/100*`
    ]

    if (c.is_multichain) {
      lines.push('', `⚠️ _Token multichain \\(${c.contracts_count} contrats\\) — le MC est agrégé sur toutes les chaînes_`)
    }

    return lines.join('\n')
  }

  buttons(snapshot) {
    const explorer = EXPLORERS[snapshot.chain]
    const address = snapshot.token.slice(snapshot.token.indexOf(':') + 1)
    const row = []
    if (explorer) row.push({ text: '📊 DexScreener', url: explorer(address) })
    if (snapshot.chain === 'solana') row.push({ text: '🔍 RugCheck', url: `https://rugcheck.xyz/tokens/${address}` })
    return {
      inline_keyboard: [
        row,
        [{ text: '🔕 Ignorer ce token', callback_data: `mute:${snapshot.token}` }]
      ].filter(r => r.length)
    }
  }

  async send(snapshot, token) {
    if (!this.available) return { skipped: true, reason: 'notificateur inactif' }
    const result = await this.#call('sendMessage', {
      chat_id: this.chatId,
      text: this.format(snapshot, token),
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      reply_markup: this.buttons(snapshot)
    })
    return { messageId: result.message_id }
  }

  async sendText(text, { chatId = this.chatId, markdown = false } = {}) {
    if (!this.available) return { skipped: true }
    return this.#call('sendMessage', {
      chat_id: chatId,
      text: markdown ? text : text,
      ...(markdown ? { parse_mode: 'MarkdownV2' } : {}),
      link_preview_options: { is_disabled: true }
    })
  }

  answerCallback(id, text) {
    return this.#call('answerCallbackQuery', { callback_query_id: id, text })
  }

  setWebhook(url, secret) {
    return this.#call('setWebhook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      ...(secret ? { secret_token: secret } : {})
    })
  }

  getMe() { return this.#call('getMe', {}) }
}

export { esc, usd, age, num }
