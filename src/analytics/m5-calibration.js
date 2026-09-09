/**
 * M5 — Calibration des filtres.
 *
 * Transforme des opinions en faits mesurés. Aujourd'hui chaque seuil est une
 * valeur qu'on a posée ; ce module répond à « ce filtre m'a-t-il protégé, ou
 * coûté de l'argent ? ».
 *
 * Tout repose sur une décision prise dès le premier jour : `trigger_snapshots`
 * stocke la VALEUR MESURÉE de chaque filtre, pas un booléen. C'est ce qui rend
 * le balayage de seuil possible sans jamais recollecter de données.
 *
 * ⚠️ Ce module ne modifie RIEN. Il propose, l'humain valide (voir M8).
 * Un système qui s'auto-modifie devient impossible à interpréter quand il se
 * dégrade, et on perd la capacité de comparer deux périodes.
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('m5')

/** Jointure snapshot × outcome, sur les décisions ayant un verdict. */
async function decisions({ days = 60, minSample = 1 } = {}) {
  const since = new Date(Date.now() - days * 86400_000)
  return col('trigger_snapshots').aggregate([
    { $match: { ts: { $gte: since } } },
    { $lookup: { from: 'outcomes', localField: '_id', foreignField: '_id', as: 'out' } },
    { $unwind: '$out' },
    { $match: { 'out.verdict': { $ne: 'PENDING' } } },
    { $project: {
        filters: 1, decision: 1, score: 1, config_version: 1,
        multiple: '$out.multiple_max', verdict: '$out.verdict', rugged: '$out.rugged'
    } }
  ]).toArray()
}

/**
 * ① Efficacité individuelle.
 *
 * Lecture : si les tokens rejetés par un filtre réussissent au même taux que
 * ceux qu'on a alertés, ce filtre ne discrimine rien — il coûte de l'argent
 * sans protéger.
 */
export function efficacy(rows, { successMultiple = 5 } = {}) {
  const reussi = r => !r.rugged && r.multiple >= successMultiple

  const alertes = rows.filter(r => r.decision === 'alerted')
  const reference = alertes.length
    ? +(alertes.filter(reussi).length / alertes.length).toFixed(3)
    : null

  const parFiltre = new Map()
  for (const r of rows) {
    for (const f of r.filters ?? []) {
      if (f.passed !== false) continue
      const e = parFiltre.get(f.name) ?? { rejetes: 0, succes: 0, rugs: 0 }
      e.rejetes++
      if (reussi(r)) e.succes++
      if (r.rugged) e.rugs++
      parFiltre.set(f.name, e)
    }
  }

  return {
    reference: { alertes: alertes.length, taux_succes: reference },
    filtres: [...parFiltre].map(([filtre, e]) => ({
      filtre,
      rejetes: e.rejetes,
      succes_apres_rejet: e.succes,
      taux: e.rejetes ? +(e.succes / e.rejetes).toFixed(3) : 0,
      rugs_evites: e.rugs,
      // Un filtre dont les rejets réussissent AUTANT que les alertés ne
      // discrimine pas. En dessous, il protège ; au-dessus, il coûte.
      verdict: reference === null ? 'indéterminé'
        : e.rejetes < 10 ? 'échantillon insuffisant'
          : (e.succes / e.rejetes) >= reference * 0.8 ? 'ne discrimine pas'
            : (e.succes / e.rejetes) <= reference * 0.3 ? 'bon filtre'
              : 'discutable'
    })).sort((a, b) => b.taux - a.taux)
  }
}

/**
 * ② Balayage de seuil.
 *
 * Possible UNIQUEMENT parce qu'on a stocké la valeur mesurée. Pour chaque
 * valeur candidate, on rejoue l'historique : combien d'alertes, quelle
 * précision ? Aucun appel réseau, aucune recollecte.
 */
export function sweep(rows, filterName, candidates, { successMultiple = 5, direction = 'below' } = {}) {
  const reussi = r => !r.rugged && r.multiple >= successMultiple

  const echantillon = rows
    .map(r => ({ valeur: r.filters?.find(f => f.name === filterName)?.value, ok: reussi(r), rugged: r.rugged }))
    .filter(x => typeof x.valeur === 'number')

  if (echantillon.length < 10) {
    return { filtre: filterName, echantillon: echantillon.length, insuffisant: true, courbe: [] }
  }

  const courbe = candidates.map(seuil => {
    const passent = echantillon.filter(x => direction === 'below' ? x.valeur < seuil : x.valeur >= seuil)
    const succes = passent.filter(x => x.ok).length
    return {
      seuil,
      alertes: passent.length,
      succes,
      taux: passent.length ? +(succes / passent.length).toFixed(3) : null,
      rugs: passent.filter(x => x.rugged).length
    }
  })

  return { filtre: filterName, echantillon: echantillon.length, direction, courbe }
}

/**
 * ③ Redondance.
 *
 * Deux filtres qui rejettent les mêmes tokens sont un doublon : on paie des
 * appels API pour rien. Indice de Jaccard sur les ensembles de rejets.
 */
export function redundancy(rows) {
  const rejets = new Map()
  for (const r of rows) {
    for (const f of r.filters ?? []) {
      if (f.passed === false) {
        if (!rejets.has(f.name)) rejets.set(f.name, new Set())
        rejets.get(f.name).add(r._id)
      }
    }
  }

  const noms = [...rejets.keys()]
  const paires = []
  for (let i = 0; i < noms.length; i++) {
    for (let j = i + 1; j < noms.length; j++) {
      const a = rejets.get(noms[i]), b = rejets.get(noms[j])
      const inter = [...a].filter(x => b.has(x)).length
      const union = new Set([...a, ...b]).size
      if (!union) continue
      paires.push({
        filtres: [noms[i], noms[j]],
        recouvrement: +(inter / union).toFixed(3),
        communs: inter,
        doublon: inter / union >= 0.8
      })
    }
  }
  return paires.sort((x, y) => y.recouvrement - x.recouvrement)
}

/**
 * ④ Ordre d'exécution.
 *
 * L'étage 5 court-circuite au premier échec : l'ordre détermine le coût total.
 * On classe par (taux de rejet ÷ coût) — le plus éliminatoire et le moins cher
 * d'abord.
 */
export async function executionOrder(rows) {
  const stats = new Map()
  for (const r of rows) {
    for (const f of r.filters ?? []) {
      const e = stats.get(f.name) ?? { evalues: 0, rejetes: 0 }
      e.evalues++
      if (f.passed === false) e.rejetes++
      stats.set(f.name, e)
    }
  }

  const { loadFilters } = await import('../pipeline/filters/index.js')
  const registre = new Map((await loadFilters()).map(f => [f.name, f]))

  return [...stats].map(([nom, e]) => {
    const cout = registre.get(nom)?.cost === 'paid' ? 10 : 1
    const taux = e.evalues ? e.rejetes / e.evalues : 0
    return {
      filtre: nom,
      evalues: e.evalues,
      taux_rejet: +taux.toFixed(3),
      cout: registre.get(nom)?.cost ?? '?',
      priorite: +(taux / cout).toFixed(4)
    }
  }).sort((a, b) => b.priorite - a.priorite)
}

// ---------------------------------------------------------------------------

export async function run(cfg, { days = 60 } = {}) {
  const rows = await decisions({ days })

  if (rows.length < 10) {
    log.info({ decisions: rows.length },
      'échantillon insuffisant — il faut des outcomes avec verdict, soit 7 jours par token')
  }

  const seuils = cfg.thresholds.filters
  const rapport = {
    period: new Date().toISOString().slice(0, 10),
    computed_at: new Date(),
    fenetre_jours: days,
    decisions: rows.length,
    efficacite: efficacy(rows),
    balayages: {
      top_holders: sweep(rows, 'top_holders',
        [15, 20, 25, seuils.top_holders, 35, 40, 50], { direction: 'below' }),
      wash_trading: sweep(rows, 'wash_trading',
        [3, 5, seuils.wash_index, 12, 20], { direction: 'below' }),
      sell_pressure: sweep(rows, 'sell_pressure',
        [1.0, seuils.sell_pressure, 1.5, 2.0, 3.0], { direction: 'above' })
    },
    redondance: redundancy(rows),
    ordre_execution: await executionOrder(rows)
  }

  await col('analytics_filter_perf').updateOne(
    { period: rapport.period }, { $set: rapport }, { upsert: true })

  log.info({ decisions: rows.length, filtres: rapport.efficacite.filtres.length }, 'calibration')
  return rapport
}
