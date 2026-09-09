/**
 * ConfigStore — source unique de vérité pour toute valeur ajustable.
 *
 * Règles (docs/architecture.md) :
 *   - aucune constante en dur ailleurs dans le projet
 *   - toute modification crée une NOUVELLE version, jamais une mise à jour en place
 *   - chaque décision estampille son `config_version`
 */

import { col } from '../db/client.js'
import { CONFIG_V1 } from './defaults.js'
import { mod } from '../logger.js'

const log = mod('config')

let cache = null
let loadedAt = 0
const TTL_MS = 60_000

/** Insère la v1 si aucune configuration n'existe. Idempotent. */
export async function seedConfig() {
  const existing = await col('config_versions').findOne({ active: true })
  if (existing) {
    log.debug({ version: existing._id }, 'configuration déjà en place')
    return existing
  }
  await col('config_versions').insertOne(CONFIG_V1)
  log.info({ version: CONFIG_V1._id }, 'configuration v1 insérée')
  return CONFIG_V1
}

/** Configuration active, avec cache court (rechargement à chaud sans redémarrage). */
export async function active({ force = false } = {}) {
  if (!force && cache && Date.now() - loadedAt < TTL_MS) return cache
  const doc = await col('config_versions').findOne({ active: true })
  if (!doc) throw new Error('Aucune configuration active — lancer `npm run db:init`')
  cache = doc
  loadedAt = Date.now()
  return doc
}

/** Lecture par chemin : get(cfg, 'thresholds.filters.top_holders') */
export function get(cfg, path, fallback = undefined) {
  const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg)
  if (v === undefined && fallback === undefined) {
    throw new Error(`Clé de configuration absente : ${path}`)
  }
  return v ?? fallback
}

/** Chaînes activées, sous la forme attendue par Mobula. */
export function enabledChains(cfg) {
  return Object.entries(cfg.features.chains).filter(([, on]) => on).map(([id]) => id)
}

export function isEnabled(cfg, feature) {
  return Boolean(cfg.features?.[feature]?.enabled)
}

/**
 * Crée une nouvelle version à partir de l'active, avec un diff tracé.
 * changes: [{ path, to, source }]
 */
export async function createVersion(changes, { createdBy = 'manual', note = '' } = {}) {
  const current = await active({ force: true })
  const next = structuredClone(current)

  const diff = []
  for (const { path, to, source = 'manual' } of changes) {
    const from = get(current, path, null)
    const keys = path.split('.')
    const last = keys.pop()
    keys.reduce((o, k) => (o[k] ??= {}), next)[last] = to
    diff.push({ path, from, to, source })
  }

  next._id = current._id + 1
  next.created_at = new Date()
  next.created_by = createdBy
  next.note = note
  next.diff_from_previous = diff

  await col('config_versions').updateOne({ _id: current._id }, { $set: { active: false } })
  await col('config_versions').insertOne(next)

  cache = null
  log.info({ version: next._id, changes: diff.length }, 'nouvelle version de configuration')
  return next
}
