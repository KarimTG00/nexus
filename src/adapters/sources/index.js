/**
 * Registre des sources de données.
 *
 * Le pipeline appelle `getSource()` et ne connaît jamais l'implémentation.
 * Changer de fournisseur, ou de stratégie de repli, = une ligne de configuration.
 */

import { MobulaSource } from './mobula.js'
import { DexscreenerSource } from './dexscreener.js'
import { CompositeSource } from './composite.js'
import { mod } from '../../core/logger.js'

const log = mod('sources')

const REGISTRY = {
  mobula: cfg => new MobulaSource({
    apiKey: process.env.MOBULA_KEY,
    batchSize: cfg.sources.batch_size,
    mergeCycles: cfg.sources.pulse_merge_cycles,
    dailyBudget: cfg.sources.daily_budget ?? 3800
  }),

  dexscreener: () => new DexscreenerSource()
}

let instance = null

export function getSource(cfg, { force = false } = {}) {
  if (instance && !force) return instance

  const primaryName = cfg.sources.primary
  const secondaryName = cfg.sources.secondary ?? null

  const build = name => {
    const f = REGISTRY[name]
    if (!f) throw new Error(`Source inconnue : ${name} (disponibles : ${Object.keys(REGISTRY).join(', ')})`)
    return f(cfg)
  }

  const primary = build(primaryName)
  instance = secondaryName
    ? new CompositeSource(primary, build(secondaryName))
    : primary

  log.info({ source: instance.name, capabilities: [...instance.capabilities] }, 'source initialisée')
  return instance
}

export function resetSource() { instance = null }
