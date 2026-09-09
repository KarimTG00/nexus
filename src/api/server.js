/**
 * Service web — trois familles de routes, volontairement séparées.
 *
 *   /webhooks/*   publiques et rapides : Helius doit recevoir un 200 en
 *                 quelques millisecondes, sinon il réessaie et finit par
 *                 désactiver le webhook. On accuse réception AVANT de traiter.
 *                 Exemptées de l'authentification Basic : ces services ne
 *                 peuvent pas s'authentifier ainsi, ils ont leurs secrets.
 *   /api/*        lecture du dashboard.
 *   le reste      le dashboard compilé, servi depuis la MÊME origine.
 *
 * Servir le dashboard ici plutôt que dans un service séparé supprime le CORS,
 * le besoin d'une URL d'API à configurer, et évite d'exposer un jeton dans le
 * bundle JavaScript.
 *
 * Serveur HTTP natif : ce service n'a que quelques routes, une dépendance de
 * framework serait du poids sans contrepartie.
 */

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ingest, verifyWebhook } from '../collector/ingest.js'
import { handleUpdate } from '../bot/commands.js'
import * as health from '../repos/health.js'
import * as positionsRepo from '../repos/positions.js'
import * as routes from './routes.js'
import { createStaticHandler, checkBasicAuth } from './static.js'
import { mod } from '../core/logger.js'

const log = mod('api')

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DASHBOARD = process.env.DASHBOARD_DIR ?? join(RACINE, 'dashboard', 'dist')

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
  const servirStatique = createStaticHandler(DASHBOARD)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Utile uniquement en développement, quand Vite sert le dashboard sur son
    // propre port. En production tout partage la même origine.
    if (process.env.DASHBOARD_ORIGIN || process.env.NODE_ENV !== 'production') {
      res.setHeader('Access-Control-Allow-Origin', process.env.DASHBOARD_ORIGIN ?? '*')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    }

    try {
      // --- sonde de la plateforme : jamais authentifiée --------------------
      // Railway et les supervisions doivent pouvoir l'interroger.
      if (path === '/health') {
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

      // --- au-delà : dashboard et API, sous authentification Basic ---------
      // Les webhooks sont traités plus haut et n'y passent jamais.
      if (!checkBasicAuth(req, res)) return

      // --- routes de lecture ------------------------------------------------
      if (path.startsWith('/api/')) {
        // Jeton porteur accepté en plus du Basic, pour un client non navigateur.
        const token = process.env.API_TOKEN
        if (token && !req.headers.authorization?.startsWith('Basic ')
            && req.headers.authorization !== `Bearer ${token}`) {
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

      // --- dashboard compilé -------------------------------------------------
      if (await servirStatique(req, res, path)) return

      return json(res, 404, { error: 'route inconnue' })
    } catch (e) {
      log.error({ path, err: e.message }, 'erreur serveur')
      if (!res.headersSent) json(res, 500, { error: 'erreur interne' })
    }
  })

  server.listen(port, () => log.info({ port }, 'service web démarré'))
  return server
}
