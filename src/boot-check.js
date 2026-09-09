/**
 * Vérification de démarrage — critère de validation de la phase P0.
 * Usage : npm run boot
 */

import { loadEnv, envStatus } from './core/env.js'
import { logger } from './core/logger.js'
import * as db from './core/db/client.js'
import * as cache from './core/cache/index.js'
import { active, enabledChains } from './core/config/store.js'
import { collectionNames } from './core/db/schema.js'

const ok = s => `  \x1b[32m✓\x1b[0m ${s}`
const ko = s => `  \x1b[31m✗\x1b[0m ${s}`
const warn = s => `  \x1b[33m!\x1b[0m ${s}`

async function main() {
  console.log('\n\x1b[1mVérification de démarrage\x1b[0m\n')
  loadEnv()

  // --- environnement -------------------------------------------------------
  console.log('Environnement')
  for (const e of envStatus()) {
    const line = `${e.key.padEnd(20)} ${e.desc}`
    console.log(e.present ? ok(line) : (e.required ? ko(line) : warn(line + ' — absent')))
  }

  // --- MongoDB -------------------------------------------------------------
  console.log('\nMongoDB')
  const database = await db.connect()
  const present = new Set((await database.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
  const missing = collectionNames.filter(n => !present.has(n))

  console.log(ok(`connecté à « ${database.databaseName} »`))
  console.log(missing.length
    ? warn(`${collectionNames.length - missing.length}/${collectionNames.length} collections — manquantes : ${missing.join(', ')}`)
    : ok(`${collectionNames.length} collections en place`))
  if (missing.length) console.log('    → lancer : npm run db:init')

  // --- cache ---------------------------------------------------------------
  console.log('\nCache')
  const c = await cache.connect()
  const pong = await c.ping()
  console.log(c.shared ? ok(`Redis — ${pong}`) : warn(`repli mémoire — ${pong} (non partagé entre processus)`))

  // --- configuration -------------------------------------------------------
  console.log('\nConfiguration')
  try {
    const cfg = await active()
    const chains = enabledChains(cfg)
    console.log(ok(`version ${cfg._id} active — ${cfg.note ?? ''}`))
    console.log(ok(`chaînes activées : ${chains.join(', ') || 'aucune'}`))
    console.log(cfg.features.alerts.enabled
      ? warn('alertes ACTIVES')
      : ok('mode calibration (alertes désactivées)'))
    console.log(ok(`seuils de déclenchement : ${cfg.thresholds.trigger.map(t => (t / 1000) + 'K').join(', ')}`))
    console.log(ok(`lot Mobula : ${cfg.sources.batch_size} tokens/crédit`))
  } catch (e) {
    console.log(ko(e.message))
  }

  console.log('\n\x1b[1mP0 opérationnelle.\x1b[0m\n')
}

main()
  .catch(e => { logger.error({ err: e.message, stack: e.stack }, 'échec du démarrage'); process.exitCode = 1 })
  .finally(async () => { await db.close(); await cache.close() })
