/**
 * Worker analytique — la face 2.
 *
 * Séparé du pipeline : il tourne à froid, sur des cadences longues, et ne
 * doit jamais ralentir la collecte. Sur Railway c'est un Cron Job, pas un
 * service permanent.
 *
 * Usage : node --env-file=.env src/workers/analytics.js [m5|m7|all]
 */

import { loadEnv } from '../core/env.js'
import { logger, mod } from '../core/logger.js'
import * as db from '../core/db/client.js'
import * as cache from '../core/cache/index.js'
import { active } from '../core/config/store.js'
import * as m7 from '../analytics/m7-blindspots.js'
import * as m5 from '../analytics/m5-calibration.js'
import * as positionsRepo from '../repos/positions.js'

const log = mod('analytics')

const MODULES = {
  // M7 d'abord : il révèle les plus gros trous, et il est le moins coûteux.
  m7: (cfg) => m7.run(cfg),
  m5: (cfg) => m5.run(cfg),
  // Entretien : clôture des positions soldées, purge des anciennes.
  maintenance: async () => ({
    closes: await positionsRepo.closeSettled(),
    purgees: await positionsRepo.purge()
  })
}

async function main() {
  loadEnv()
  await db.connect()
  await cache.connect()
  const cfg = await active()

  const demande = (process.argv[2] ?? 'all').toLowerCase()
  const aLancer = demande === 'all' ? Object.keys(MODULES) : [demande]

  for (const nom of aLancer) {
    const fn = MODULES[nom]
    if (!fn) { log.warn({ module: nom }, 'module inconnu'); continue }
    const t0 = Date.now()
    try {
      const r = await fn(cfg)
      log.info({ module: nom, duree_s: +((Date.now() - t0) / 1000).toFixed(1) },
        r ? 'terminé' : 'terminé sans résultat')
    } catch (e) {
      log.error({ module: nom, err: e.message }, 'module en échec')
    }
  }

  await db.close()
  await cache.close()
}

main().catch(e => {
  logger.error({ err: e.message, stack: e.stack }, 'analytics impossible')
  process.exit(1)
})
