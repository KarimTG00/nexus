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
import { mod } from '../core/logger.js'

const log = mod('collector:webhook')
const BASE = 'https://api.helius.xyz/v0/webhooks'

const key = () => process.env.HELIUS_KEY

/** Adresses à surveiller : les mints Solana encore vivants. */
export async function addressesToWatch({ limit = 100_000 } = {}) {
  const docs = await col('tokens').find(
    { chain: 'solana', status: { $in: ['pending_activity', 'tracked', 'triggered', 'alerted'] } },
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
export async function sync({ webhookID, webhookURL, force = false } = {}) {
  const addresses = await addressesToWatch()
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
