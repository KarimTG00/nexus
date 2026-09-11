/**
 * Flux temps réel pump.fun, seul — pour le développement et les essais.
 *
 * En production il tourne DANS le pipeline (`pipeline.js`). Ne pas lancer les
 * deux à la fois : chaque alerte partirait deux fois. Pour lancer le pipeline
 * en local sans le flux, mettre `STREAM=off` dans `.env`.
 *
 * Usage : npm run stream
 */

import { loadEnv } from '../core/env.js'
import { logger } from '../core/logger.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { active } from '../core/config/store.js'
import { demarrerFlux, arreterFlux, actualiserConfig } from '../collector/pump/stream.js'

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()
  await demarrerFlux(await active())

  // Même rechargement à chaud que le pipeline : une nouvelle version de
  // configuration s'applique sans redémarrage.
  const rechargement = setInterval(async () => {
    try { actualiserConfig(await active()) } catch { /* configuration inchangée */ }
  }, 60_000)

  const arreter = async signal => {
    logger.info({ signal }, 'arrêt du flux')
    clearInterval(rechargement)
    await arreterFlux()
    await db.close()
    await cache.close()
    process.exit(0)
  }
  process.on('SIGINT', () => arreter('SIGINT'))
  process.on('SIGTERM', () => arreter('SIGTERM'))
  process.on('unhandledRejection', e => logger.error({ err: e?.message, stack: e?.stack }, 'rejet non capturé'))
}

main().catch(e => {
  logger.error({ err: e.message, stack: e.stack }, 'flux impossible à démarrer')
  process.exit(1)
})
