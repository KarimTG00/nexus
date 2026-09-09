/**
 * Service web — deux familles de routes, volontairement séparées.
 *
 *   /webhooks/*   publiques et rapides : Helius doit recevoir un 200 en
 *                 quelques millisecondes, sinon il réessaie et finit par
 *                 désactiver le webhook. On accuse réception AVANT de traiter.
 *   /api/*        authentifiées : santé, entonnoir, statistiques.
 *
 * Serveur HTTP natif : ce service n'a que quelques routes, une dépendance de
 * framework serait du poids sans contrepartie.
 */

import { createServer } from 'node:http'
import { ingest, verifyWebhook } from '../collector/ingest.js'
import { handleUpdate } from '../bot/commands.js'
import * as health from '../repos/health.js'
import * as positionsRepo from '../repos/positions.js'
import * as routes from './routes.js'
import { mod } from '../core/logger.js'

const log = mod('api')

const json = (res, code, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req, { maxBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > maxBytes) { reject(new Error('charge utile trop volumineuse')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) }
      catch (e) { reject(new Error('JSON invalide')) }
    })
    req.on('error', reject)
  })
}

export function createApiServer({ port = process.env.PORT ?? 3000 } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Le dashboard tourne sur une autre origine en développement (Vite).
    // En production, restreindre via DASHBOARD_ORIGIN.
    res.setHeader('Access-Control-Allow-Origin', process.env.DASHBOARD_ORIGIN ?? '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    try {
      // --- santé : sonde de la plateforme, sans authentification -----------
      if (path === '/health' || path === '/') {
        const h = await health.health()
        return json(res, h.alive ? 200 : 503, h)
      }

      // --- webhook Helius : accuser réception AVANT de traiter -------------
      if (path === '/webhooks/helius' && req.method === 'POST') {
        if (!verifyWebhook(req.headers, process.env.HELIUS_WEBHOOK_SECRET)) {
          return json(res, 401, { error: 'non autorisé' })
        }

        let body
        try { body = await readBody(req) }
        catch (e) { return json(res, 400, { error: e.message }) }

        // Helius désactive un webhook qui répond trop lentement : on répond
        // tout de suite et on traite ensuite.
        json(res, 200, { received: Array.isArray(body) ? body.length : 1 })

        const txs = Array.isArray(body) ? body : [body]
        ingest(txs)
          .then(s => { if (s.swaps) log.info(s, 'swaps ingérés') })
          .catch(e => log.error({ err: e.message }, 'ingestion en échec'))
        return
      }

      // --- webhook Telegram -------------------------------------------------
      if (path === '/webhooks/telegram' && req.method === 'POST') {
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET
        if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
          return json(res, 401, { error: 'non autorisé' })
        }
        let update
        try { update = await readBody(req) }
        catch (e) { return json(res, 400, { error: e.message }) }

        // Telegram réessaie si la réponse tarde : on accuse réception d'abord.
        json(res, 200, { ok: true })
        handleUpdate(update).catch(e => log.error({ err: e.message }, 'commande en échec'))
        return
      }

      // --- routes authentifiées --------------------------------------------
      if (path.startsWith('/api/')) {
        const token = process.env.API_TOKEN
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          return json(res, 401, { error: 'non autorisé' })
        }

        const p = Object.fromEntries(url.searchParams)

        if (path === '/api/overview') return json(res, 200, await routes.overview())
        if (path === '/api/analytics') return json(res, 200, await routes.analytics())
        if (path === '/api/tokens') return json(res, 200, await routes.listTokens(p))
        if (path === '/api/triggers') return json(res, 200, await routes.recentTriggers(p))
        if (path === '/api/funnel') return json(res, 200, await health.funnel() ?? {})
        if (path === '/api/positions') return json(res, 200, await positionsRepo.stats())

        // /api/tokens/{chain}:{address} — l'identifiant contient des « : »
        const m = path.match(/^\/api\/tokens\/(.+)$/)
        if (m) {
          const detail = await routes.tokenDetail(decodeURIComponent(m[1]))
          return detail
            ? json(res, 200, detail)
            : json(res, 404, { error: 'token inconnu' })
        }

        return json(res, 404, { error: 'route inconnue' })
      }

      return json(res, 404, { error: 'route inconnue' })
    } catch (e) {
      log.error({ path, err: e.message }, 'erreur serveur')
      if (!res.headersSent) json(res, 500, { error: 'erreur interne' })
    }
  })

  server.listen(port, () => log.info({ port }, 'service web démarré'))
  return server
}
