/**
 * Score final — déterministe, versionné, sans IA.
 *
 * Deux propriétés qui comptent (docs/architecture.md) :
 *   - la formule itère sur les sous-scores PRÉSENTS et renormalise les poids.
 *     Ajouter un sous-score = un collecteur + une ligne de config.
 *   - aucune improvisation à l'exécution : la face 2 doit pouvoir rejouer
 *     n'importe quelle décision passée à l'identique.
 *
 * Normalisation par RANG PERCENTILE glissant sur 30 jours : en marché froid
 * +40 peut valoir 90/100, en marché chaud +145 peut n'en valoir que 60.
 * Le score s'adapte au régime sans qu'on touche à un seuil.
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('scoring')

/** Échelles de repli tant que l'historique est trop mince pour un percentile. */
const FALLBACK = {
  velocity: { min: -20, max: 150 },
  flow: { min: 0, max: 10 },
  security: { min: 0, max: 100 },
  social: { min: 0, max: 100 },
  deployer: { min: 0, max: 100 }
}

const MIN_HISTORY = 30   // en deçà, un percentile n'a pas de sens

/**
 * Rang percentile d'une valeur dans une distribution historique.
 * @returns {number|null} 0-100, ou null si l'historique est insuffisant
 */
export function percentileRank(value, distribution) {
  if (value === null || value === undefined) return null
  const sorted = distribution.filter(v => v !== null && v !== undefined).sort((a, b) => a - b)
  if (sorted.length < MIN_HISTORY) return null
  let below = 0
  for (const v of sorted) { if (v < value) below++; else break }
  return Math.round(below / sorted.length * 100)
}

/** Repli linéaire borné, quand l'historique manque. */
function linearScale(value, { min, max }) {
  if (value === null || value === undefined) return null
  const clamped = Math.max(min, Math.min(max, value))
  return Math.round((clamped - min) / (max - min) * 100)
}

/**
 * Distributions des 30 derniers jours, un tableau par sous-score.
 * Lues sur trigger_snapshots — d'où l'importance d'y stocker les valeurs brutes.
 */
export async function loadDistributions({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400_000)
  const rows = await col('trigger_snapshots')
    .find({ ts: { $gte: since } }, { projection: { raw_subscores: 1 } })
    .toArray()

  const dist = {}
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.raw_subscores ?? {})) {
      if (v === null || v === undefined) continue
      ;(dist[k] ??= []).push(v)
    }
  }
  return dist
}

/**
 * Convertit les valeurs brutes en sous-scores 0-100.
 * @param {Object} raw            { velocity: 145, flow: 11.1, … }
 * @param {Object} distributions  historique par clé
 */
export function normalize(raw, distributions = {}) {
  const out = {}
  const method = {}

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) { out[key] = null; method[key] = 'absent'; continue }

    const pct = percentileRank(value, distributions[key] ?? [])
    if (pct !== null) { out[key] = pct; method[key] = 'percentile' }
    else if (FALLBACK[key]) { out[key] = linearScale(value, FALLBACK[key]); method[key] = 'linéaire' }
    else { out[key] = null; method[key] = 'inconnu' }
  }

  return { subscores: out, method }
}

/**
 * Moyenne pondérée, renormalisée sur les sous-scores présents.
 *
 * Un sous-score absent (social indisponible à 150K) ne pénalise pas le token :
 * son poids est redistribué. Sans ça, on punirait un token pour une donnée
 * qu'on n'a pas su collecter.
 */
export function score(subscores, weights) {
  const present = Object.keys(weights).filter(k =>
    subscores[k] !== null && subscores[k] !== undefined)

  if (!present.length) return { score: null, weightsUsed: {}, coverage: 0 }

  const totalWeight = present.reduce((s, k) => s + weights[k], 0)
  const value = present.reduce((s, k) => s + subscores[k] * weights[k], 0) / totalWeight

  const weightsUsed = Object.fromEntries(
    present.map(k => [k, +(weights[k] / totalWeight).toFixed(3)]))

  return {
    score: Math.round(value),
    weightsUsed,
    coverage: +(present.length / Object.keys(weights).length).toFixed(2)
  }
}

/** Chaîne complète : valeurs brutes → sous-scores → note finale. */
export async function computeScore(raw, cfg, { distributions = null } = {}) {
  const dist = distributions ?? await loadDistributions()
  const { subscores, method } = normalize(raw, dist)
  const result = score(subscores, cfg.weights)

  const usingPercentile = Object.values(method).filter(m => m === 'percentile').length
  if (usingPercentile === 0) {
    log.debug({ historique: Object.keys(dist).length },
      'aucun percentile disponible — repli linéaire, à recalibrer quand l\'historique sera fourni')
  }

  return { ...result, subscores, raw, method }
}
