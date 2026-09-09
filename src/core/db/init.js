/**
 * Création idempotente des collections, index et validateurs.
 * Relançable sans risque : `npm run db:init`
 */

import { connect, getDb, close } from './client.js'
import { collections } from './schema.js'
import { seedConfig } from '../config/store.js'
import { pathToFileURL } from 'node:url'
import { mod } from '../logger.js'

const log = mod('db:init')

export async function initDb() {
  const db = await connect()
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))

  for (const spec of collections) {
    const { name, timeseries, expireAfterSeconds, validator, indexes = [] } = spec

    if (!existing.has(name)) {
      const opts = {}
      if (timeseries) opts.timeseries = timeseries
      if (expireAfterSeconds) opts.expireAfterSeconds = expireAfterSeconds
      if (validator) { opts.validator = validator; opts.validationLevel = 'moderate' }

      await db.createCollection(name, opts)
      log.info({ collection: name, timeseries: Boolean(timeseries) }, 'collection créée')
    } else if (validator) {
      // Met à jour le validateur d'une collection existante (migration additive)
      await db.command({ collMod: name, validator, validationLevel: 'moderate' })
        .catch(e => log.warn({ collection: name, err: e.message }, 'validateur non appliqué'))
    }

    // Les collections time-series n'acceptent pas d'index secondaires classiques ici
    if (timeseries) continue

    for (const ix of indexes) {
      const { key, name: ixName, ...opts } = ix
      await db.collection(name).createIndex(key, { name: ixName, ...opts })
        .catch(e => log.warn({ collection: name, index: ixName, err: e.message }, 'index non créé'))
    }
  }

  await seedConfig()

  const total = (await db.listCollections({}, { nameOnly: true }).toArray()).length
  log.info({ collections: total }, 'schéma en place')
  return db
}

// Exécution directe (pathToFileURL : robuste sous Windows comme sous POSIX)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  initDb()
    .then(() => close())
    .then(() => process.exit(0))
    .catch(e => { log.error({ err: e.message }, 'échec'); process.exit(1) })
}
