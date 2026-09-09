/**
 * Worker du service web — reçoit les webhooks Helius et sert l'API interne.
 *
 * Séparé du worker pipeline : Railway redéploie et redémarre les services
 * indépendamment, et un webhook manqué est une transaction perdue. Les deux
 * partagent la base et le cache, jamais leur cycle de vie.
 */

import { loadEnv } from '../core/env.js'
import { logger, mod } from '../core/logger.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { createApiServer } from '../api/server.js'

const log = mod('worker:api')

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()

  const server = createApiServer()

  const shutdown = async signal => {
    log.info({ signal }, 'arrêt demandé')
    server.close()
    await db.close()
    await cache.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch(e => {
  logger.error({ err: e.message, stack: e.stack }, 'démarrage impossible')
  process.exit(1)
})
