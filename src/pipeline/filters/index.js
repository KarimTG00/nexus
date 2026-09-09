/**
 * Registre de filtres — auto-découverte.
 *
 * Ajouter un filtre = déposer un fichier dans un sous-dossier. Aucune ligne
 * de pipeline à modifier (docs/architecture.md).
 *
 * Contrat d'un filtre :
 *   name       identifiant stable — sert de rejection_reason, ne jamais renommer
 *   stage      'admission' | 'activity' | 'deep' | 'score'
 *              'score' s'exécute APRÈS le calcul de la note, sur son résultat
 *   blocking   true = rejette, false = simple bonus de score
 *   cost       'free' | 'paid' — pilote l'ordre d'exécution
 *   configKey  chemin du seuil dans la configuration
 *   requires   données à pré-charger (union calculée par l'étage)
 *   enabled    activable/désactivable sans suppression
 *   evaluate(ctx, threshold) -> { value, passed, skipped?, detail? }
 */

import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mod } from '../../core/logger.js'

const log = mod('filters')
const HERE = dirname(fileURLToPath(import.meta.url))

let registry = null

export async function loadFilters({ force = false } = {}) {
  if (registry && !force) return registry

  const found = []
  for (const stage of ['admission', 'activity', 'deep', 'score']) {
    let files = []
    try {
      files = (await readdir(join(HERE, stage))).filter(f => f.endsWith('.js'))
    } catch { continue }   // dossier absent = étage pas encore écrit

    for (const f of files) {
      const url = pathToFileURL(join(HERE, stage, f)).href
      const { default: filter } = await import(url)
      if (!filter?.name || typeof filter.evaluate !== 'function') {
        log.warn({ file: `${stage}/${f}` }, 'filtre ignoré : contrat non respecté')
        continue
      }
      found.push({ stage, ...filter })
    }
  }

  registry = found
  log.info({ count: found.length, noms: found.map(f => f.name).join(', ') }, 'filtres chargés')
  return registry
}

/** Filtres actifs d'un étage, triés du moins cher au plus cher.
 *  L'ordre fin sera piloté par M5 (taux de rejet × coût). */
export async function filtersFor(stage, { rejectionRates = {} } = {}) {
  const all = await loadFilters()
  return all
    .filter(f => f.stage === stage && f.enabled !== false)
    .sort((a, b) => {
      const costA = a.cost === 'paid' ? 1 : 0
      const costB = b.cost === 'paid' ? 1 : 0
      if (costA !== costB) return costA - costB
      // à coût égal, le plus éliminatoire d'abord
      return (rejectionRates[b.name] ?? 0) - (rejectionRates[a.name] ?? 0)
    })
}

/** Union des données à pré-charger pour un étage. */
export async function requirementsFor(stage) {
  const list = await filtersFor(stage)
  return [...new Set(list.flatMap(f => f.requires ?? []))]
}

/**
 * Exécute les filtres d'un étage, court-circuit au premier échec bloquant.
 * @returns {{ passed, results, rejectionReason }}
 */
export async function runFilters(stage, ctx, cfg, { rejectionRates } = {}) {
  const list = await filtersFor(stage, { rejectionRates })
  const results = []
  let rejectionReason = null

  for (const f of list) {
    const threshold = f.configKey
      ? f.configKey.split('.').reduce((o, k) => o?.[k], cfg)
      : null

    let r
    try {
      r = await f.evaluate(ctx, threshold)
    } catch (e) {
      log.warn({ filtre: f.name, token: ctx._id, err: e.message }, 'filtre en erreur')
      r = { value: null, passed: true, skipped: true, detail: `erreur: ${e.message}` }
    }

    results.push({
      name: f.name,
      value: r.value ?? null,
      threshold: threshold ?? null,
      passed: r.passed !== false,
      ...(r.skipped ? { skipped: true } : {}),
      ...(r.detail ? { detail: r.detail } : {})
    })

    if (r.passed === false && f.blocking) { rejectionReason = f.name; break }
  }

  return { passed: rejectionReason === null, results, rejectionReason }
}

export function resetFilters() { registry = null }
