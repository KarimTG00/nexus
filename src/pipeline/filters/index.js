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
  // `stream` : filtres propres au flux temps réel, évalués avant `deep`.
  for (const stage of ['admission', 'activity', 'stream', 'deep', 'score']) {
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
export async function filtersFor(stage, { rejectionRates = {}, exclude = [] } = {}) {
  const all = await loadFilters()
  return all
    // `exclude` retire des filtres pour une population donnée sans les
    // désactiver pour les autres : le flux temps réel écarte ceux qui lisent
    // le nombre de traders, que les tokens manipulés gonflent par construction.
    .filter(f => f.stage === stage && f.enabled !== false && !exclude.includes(f.name))
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
export async function runFilters(stage, ctx, cfg, { rejectionRates, exclude, mesureSeule = [] } = {}) {
  const list = await filtersFor(stage, { rejectionRates, exclude })
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

    // `mesureSeule` : le filtre est évalué et sa valeur enregistrée, mais il
    // ne rejette rien. C'est ce qui permet à M5 de balayer son seuil plus
    // tard — un filtre simplement retiré ne laisserait aucune trace, et on
    // ne saurait jamais s'il avait du signal. `enforced: false` marque la
    // ligne pour qu'on ne la confonde pas avec une vraie décision.
    const applique = !mesureSeule.includes(f.name)

    results.push({
      name: f.name,
      value: r.value ?? null,
      // Le seuil RÉELLEMENT appliqué. Un filtre qui retombe sur sa valeur par
      // défaut, faute de clé en configuration, le dit dans son résultat :
      // enregistrer `null` ferait croire à M5 qu'aucun seuil n'a décidé, alors
      // qu'un seuil a bien décidé — celui du code.
      threshold: r.threshold ?? threshold ?? null,
      passed: r.passed !== false,
      ...(applique ? {} : { enforced: false }),
      ...(r.skipped ? { skipped: true } : {}),
      ...(r.detail ? { detail: r.detail } : {})
    })

    if (r.passed === false && f.blocking && applique) { rejectionReason = f.name; break }
  }

  return { passed: rejectionReason === null, results, rejectionReason }
}

export function resetFilters() { registry = null }
