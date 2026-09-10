/**
 * Gestion du webhook Helius — enregistre et tient à jour la liste des adresses
 * surveillées.
 *
 * ⚠️ Chaque création / modification / suppression de webhook coûte
 * 100 crédits Helius. On ne synchronise donc que si la liste a réellement
 * changé, et jamais à chaque cycle.
 */

import { request } from '../core/net/http.js'
import { col } from '../core/db/client.js'
import { statutsSurveilles } from './scope.js'
import { mod } from '../core/logger.js'

const log = mod('collector:webhook')
const BASE = 'https://api.helius.xyz/v0/webhooks'

const key = () => process.env.HELIUS_KEY

/** Adresses à surveiller : les mints Solana du périmètre retenu (voir scope.js). */
export async function addressesToWatch({ limit = 100_000, cfg = null } = {}) {
  const docs = await col('tokens').find(
    { chain: 'solana', status: { $in: statutsSurveilles(cfg) } },
    { projection: { address: 1 } }
  ).limit(limit).toArray()
  return docs.map(d => d.address)
}

export async function list() {
  const { json } = await request(`${BASE}?api-key=${key()}`)
  return Array.isArray(json) ? json : []
}

export async function get(id) {
  const { json } = await request(`${BASE}/${id}?api-key=${key()}`)
  return json
}

/**
 * Aligne le webhook sur la liste courante.
 * @param {string} webhookURL  URL publique du service (route /webhooks/helius)
 */
export async function sync({ webhookID, webhookURL, force = false, cfg = null } = {}) {
  const addresses = await addressesToWatch({ cfg })
  if (!addresses.length) return { skipped: true, reason: 'aucune adresse à surveiller' }

  const body = {
    webhookURL,
    transactionTypes: ['SWAP'],
    accountAddresses: addresses,
    webhookType: 'enhanced',
    ...(process.env.HELIUS_WEBHOOK_SECRET ? { authHeader: process.env.HELIUS_WEBHOOK_SECRET } : {})
  }

  // Création
  if (!webhookID) {
    const { json } = await request(`${BASE}?api-key=${key()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    await rememberWebhookId(json?.webhookID)
    log.info({ webhookID: json?.webhookID, adresses: addresses.length }, 'webhook créé')
    return { created: true, webhookID: json?.webhookID, addresses: addresses.length }
  }

  // Mise à jour — seulement si la liste a bougé (100 crédits par appel)
  if (!force) {
    const current = await get(webhookID).catch(() => null)
    const known = new Set(current?.accountAddresses ?? [])
    const manquantes = addresses.filter(a => !known.has(a))
    if (!manquantes.length) {
      return { skipped: true, reason: 'liste inchangée', addresses: known.size }
    }
    log.info({ manquantes: manquantes.length, total: addresses.length }, 'webhook à resynchroniser')
  }

  await request(`${BASE}/${webhookID}?api-key=${key()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  log.info({ webhookID, adresses: addresses.length }, 'webhook mis à jour')
  return { updated: true, webhookID, addresses: addresses.length }
}

// ---------------------------------------------------------------------------
// Etat persistant et decision de synchronisation
// ---------------------------------------------------------------------------

const STATE_ID = 'collector'

/**
 * L identifiant du webhook DOIT survivre aux redemarrages.
 *
 * Sans cela, chaque deploiement en creerait un nouveau : 100 credits a chaque
 * fois, et autant de webhooks concurrents poussant les memes transactions.
 * On le lit d abord en base, ou il est ecrit a la creation, et on retombe sur
 * la variable d environnement pour un webhook cree a la main.
 */
export async function resolveWebhookId() {
  const doc = await col('system_state').findOne({ _id: STATE_ID })
  return doc?.webhook_id ?? process.env.HELIUS_WEBHOOK_ID ?? null
}

async function rememberWebhookId(id) {
  if (!id) return
  await col('system_state').updateOne({ _id: STATE_ID },
    { $set: { webhook_id: id, created_at: new Date() } }, { upsert: true })
}

async function state() {
  return (await col('system_state').findOne({ _id: STATE_ID })) ?? {}
}

/** URL publique ou Helius doit pousser. Absente = collecteur inerte. */
export function webhookUrl() {
  let base = process.env.PUBLIC_URL
  if (!base) return null
  while (base.endsWith('/')) base = base.slice(0, -1)
  return base + '/webhooks/helius'
}

/**
 * Synchronise si — et seulement si — cela en vaut le cout.
 *
 * Une mise a jour coute 100 credits quel que soit le nombre d adresses. On
 * attend donc d en avoir assez (`min_new_addresses`), mais jamais au-dela de
 * `max_wait_min` : passe ce delai on paie, meme pour trois adresses, parce
 * qu une adresse enregistree en retard fait perdre les premiers acheteurs du
 * token — precisement ce que M2 cherche.
 */
export async function syncIfNeeded(cfg) {
  if (!cfg?.features?.swap_collector?.enabled) {
    return { skipped: true, reason: 'collecteur desactive' }
  }

  const url = webhookUrl()
  if (!url) {
    log.warn('PUBLIC_URL absente — le collecteur ne peut pas indiquer a Helius '
      + 'ou pousser les swaps. Aucune position ne sera collectee.')
    return { skipped: true, reason: 'PUBLIC_URL absente' }
  }

  const seuils = cfg.thresholds?.collector ?? {}
  const minNew = seuils.min_new_addresses ?? 20
  const maxWaitMs = (seuils.max_wait_min ?? 120) * 60_000

  const webhookID = await resolveWebhookId()
  if (!webhookID) return sync({ webhookURL: url, cfg })   // creation : rien a arbitrer

  const addresses = await addressesToWatch({ cfg })
  if (!addresses.length) return { skipped: true, reason: 'aucune adresse a surveiller' }

  const current = await get(webhookID).catch(() => null)
  if (!current) {
    // Webhook disparu cote Helius (supprime a la main, ou identifiant perime).
    log.warn({ webhookID }, 'webhook introuvable — recreation')
    await col('system_state').updateOne({ _id: STATE_ID },
      { $unset: { webhook_id: '' } }, { upsert: true })
    return sync({ webhookURL: url, cfg })
  }

  const known = new Set(current.accountAddresses ?? [])
  const vivantes = new Set(addresses)
  const manquantes = addresses.filter(a => !known.has(a))

  // Les adresses devenues obsoletes comptent AUTANT que celles qui manquent.
  // La synchronisation ne regardait que les ajouts, donc un token archive
  // restait enregistre indefiniment et Helius continuait a livrer ses swaps.
  // Mesure sur 92 502 positions : 65 % venaient de tokens `archived` et 23 %
  // de `quarantine` — 88 % du flux, et des credits, pour des tokens ecartes.
  const obsoletes = [...known].filter(a => !vivantes.has(a))
  const derive = manquantes.length + obsoletes.length

  const s = await state()
  if (!derive) {
    if (s.pending_since) {
      await col('system_state').updateOne({ _id: STATE_ID }, { $unset: { pending_since: '' } })
    }
    return { skipped: true, reason: 'liste inchangee', addresses: known.size }
  }

  const depuis = s.pending_since ? Date.now() - new Date(s.pending_since).getTime() : 0
  if (derive < minNew && depuis < maxWaitMs) {
    if (!s.pending_since) {
      await col('system_state').updateOne({ _id: STATE_ID },
        { $set: { pending_since: new Date() } }, { upsert: true })
    }
    return { skipped: true, reason: 'delta insuffisant',
             manquantes: manquantes.length, obsoletes: obsoletes.length,
             seuil: minNew, attente_min: Math.round(depuis / 60_000) }
  }

  const r = await sync({ webhookID, webhookURL: url, force: true, cfg })
  await col('system_state').updateOne({ _id: STATE_ID },
    { $set: { last_sync_at: new Date(), addresses: addresses.length,
              dernieres_obsoletes: obsoletes.length },
      $unset: { pending_since: '' },
      $inc: { helius_credits: 100, syncs: 1 } }, { upsert: true })
  return { ...r, manquantes: manquantes.length, obsoletes: obsoletes.length, credits: 100 }
}
