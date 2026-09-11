/**
 * M9 — Ce que le système a réellement attrapé.
 *
 * Les autres modules mesurent des étapes. Celui-ci mesure le résultat, avec la
 * définition la plus exigeante : un token n'a pas « réussi » parce qu'il est
 * monté, mais parce qu'on l'a attrapé AVANT qu'il monte.
 *
 * ┌─ RÉUSSITE ────────────────────────────────────────────────────────────┐
 * │  surveillé  →  alerté  →  sommet ≥ seuil_reussite                     │
 * │  ET capitalisation à l'alerte ≤ plafond de capture                    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * La seconde condition est celle qui donne son sens à la mesure. Un token qui
 * bondit directement à 1 M puis fait 5 M gonflerait le score sans qu'on ait
 * rien capturé : au moment de l'alerte, le mouvement avait déjà eu lieu. Le
 * système a envoyé exactement ce genre d'alerte — 1 M annoncé sur ROBIN quand
 * il valait 14 M — et sans ce garde-fou elles compteraient comme des succès.
 *
 * On distingue donc trois populations, et l'écart entre elles est le vrai
 * diagnostic :
 *   explosés    tous les tokens surveillés montés au-dessus d'un seuil
 *   alertés     ceux pour lesquels une alerte est partie
 *   capturés    ceux alertés assez bas pour être achetables — les seuls succès
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('m9')

/** Paliers d'explosion observés, en dollars. */
const PALIERS = [1_000_000, 3_000_000, 5_000_000, 10_000_000]

/**
 * Sommet atteint par un token, tous relevés confondus.
 *
 * `outcomes.mc_max` est la source de vérité quand elle existe : c'est le
 * registre de suivi post-déclenchement. À défaut, on retombe sur la série de
 * relevés, puis sur la capitalisation courante — un token jamais déclenché n'a
 * pas d'outcome, et il faut quand même savoir jusqu'où il est monté.
 */
export async function sommets(tokenIds) {
  const out = new Map()
  if (!tokenIds.length) return out

  for (const o of await col('outcomes').find(
    { token: { $in: tokenIds } }, { projection: { token: 1, mc_max: 1 } }).toArray()) {
    const actuel = out.get(o.token) ?? 0
    if ((o.mc_max ?? 0) > actuel) out.set(o.token, o.mc_max)
  }

  const manquants = tokenIds.filter(id => !out.has(id))
  if (manquants.length) {
    for (const r of await col('token_metrics').aggregate([
      { $match: { 'meta.token': { $in: manquants } } },
      { $group: { _id: '$meta.token', mc: { $max: '$mc' } } }
    ]).toArray()) {
      out.set(r._id, r.mc ?? 0)
    }
  }

  const encoreManquants = tokenIds.filter(id => !out.has(id))
  if (encoreManquants.length) {
    for (const t of await col('tokens').find(
      { _id: { $in: encoreManquants } }, { projection: { 'market.mc': 1 } }).toArray()) {
      out.set(t._id, t.market?.mc ?? 0)
    }
  }

  return out
}

/**
 * Capitalisation la PREMIÈRE fois qu'on a vu le token.
 *
 * C'est elle qui dit si une montée était capturable. Sans elle, un jeton déjà
 * à 8 M lors de sa découverte compterait comme une explosion manquée, alors
 * qu'il n'y avait rien à attraper.
 *
 * Le premier relevé fait foi ; à défaut, `candidates.mc_at_admission` figé à
 * l'admission ; sinon on renvoie `null`, et l'appelant écarte le token plutôt
 * que de deviner.
 */
export async function capitalisationsDepart(tokenIds) {
  const out = new Map()
  if (!tokenIds.length) return out

  for (const r of await col('token_metrics').aggregate([
    { $match: { 'meta.token': { $in: tokenIds } } },
    { $sort: { ts: 1 } },
    { $group: { _id: '$meta.token', mc: { $first: '$mc' } } }
  ]).toArray()) {
    if (r.mc != null) out.set(r._id, r.mc)
  }

  const manquants = tokenIds.filter(id => !out.has(id))
  if (manquants.length) {
    for (const t of await col('tokens').find(
      { _id: { $in: manquants } },
      { projection: { 'candidates.mc_at_admission': 1, 'market.mc': 1, admitted_at: 1 } }).toArray()) {
      const v = t.candidates?.mc_at_admission
      if (v != null) out.set(t._id, v)
    }
  }

  return out
}

/**
 * Capitalisation au moment de l'alerte — ce qu'on aurait payé.
 * Lue sur le snapshot de déclenchement, qui la fige (`context.mc`).
 */
export async function capitalisationsAlerte() {
  // Les alertes de SORTIE (×10, ventes d'auteurs) ne sont pas des entrées :
  // les compter ferait passer une sortie pour la première alerte d'un token.
  const alertes = await col('alerts').find({ kind: { $nin: ['exit_x10', 'exit_authors'] } }, {
    projection: { token: 1, trigger_id: 1, symbol: 1, chain: 1, threshold: 1, score: 1, sent_at: 1 }
  }).toArray()
  if (!alertes.length) return []

  const snaps = new Map((await col('trigger_snapshots').find(
    { _id: { $in: alertes.map(a => a.trigger_id) } },
    { projection: { 'context.mc': 1, 'context.age_minutes': 1 } }).toArray())
    .map(s => [s._id, s]))

  return alertes.map(a => ({
    ...a,
    mc_alerte: snaps.get(a.trigger_id)?.context?.mc ?? null,
    age_minutes: snaps.get(a.trigger_id)?.context?.age_minutes ?? null
  }))
}

/**
 * Rapport complet.
 *
 * @param {Object} cfg
 * @param {Object} opts
 *   plafondCapture  au-dessus, une alerte n'était plus achetable
 *   seuilReussite   sommet à atteindre pour parler de réussite
 */
export async function rapport(cfg, { plafondCapture = null, seuilReussite = 3_000_000 } = {}) {
  const plafond = plafondCapture ?? cfg?.thresholds?.alert?.max_mc ?? 2_000_000

  // --- population 1 : tout ce qui a été surveillé --------------------------
  const surveilles = await col('tokens').find(
    { $or: [{ admitted_at: { $ne: null } }, { status: { $in: ['tracked', 'triggered', 'alerted'] } }] },
    { projection: { symbol: 1, chain: 1, admitted_at: 1, discovered_at: 1, status: 1 } }
  ).toArray()

  const ids = surveilles.map(t => t._id)
  const pic = await sommets(ids)
  const depart = await capitalisationsDepart(ids)

  // Deux comptages, et l'écart entre eux est le vrai enseignement.
  //
  // `explosés` compte tout ce qui a dépassé le palier, y compris ce qui était
  // DÉJÀ au-dessus la première fois qu'on l'a vu — cas fréquent, la
  // capitalisation de Mobula étant agrégée sur toutes les chaînes : un jeton
  // ancien qui reçoit un nouveau pool apparaît d'emblée à plusieurs millions.
  //
  // `montés` ne compte que ceux partis SOUS le plafond de capture. Ce sont les
  // seuls qu'on pouvait attraper, donc les seuls dont l'absence est un échec.
  const explosés = {}
  const montés = {}
  for (const p of PALIERS) {
    explosés[p] = ids.filter(id => (pic.get(id) ?? 0) >= p).length
    montés[p] = ids.filter(id => {
      const d = depart.get(id)
      return d !== null && d !== undefined && d <= plafond && (pic.get(id) ?? 0) >= p
    }).length
  }

  // --- population 2 : ce pour quoi une alerte est partie -------------------
  const alertes = await capitalisationsAlerte()

  // --- population 3 : les captures réelles ---------------------------------
  const parToken = new Map()
  for (const a of alertes) {
    // Une seule ligne par token : la PREMIÈRE alerte, la seule qu'on aurait
    // pu suivre. Compter les suivantes gonflerait le résultat avec des
    // paliers franchis alors qu'on était déjà entré.
    const vu = parToken.get(a.token)
    if (!vu || a.sent_at < vu.sent_at) parToken.set(a.token, a)
  }

  const reussis = []
  for (const [tokenId, a] of parToken) {
    const sommet = pic.get(tokenId) ?? 0
    const capturable = a.mc_alerte !== null && a.mc_alerte <= plafond
    const monte = sommet >= seuilReussite

    if (!capturable || !monte) continue
    reussis.push({
      token: tokenId,
      symbol: a.symbol,
      chain: a.chain,
      alerte_le: a.sent_at,
      palier: a.threshold,
      score: a.score,
      mc_alerte: a.mc_alerte,
      mc_sommet: sommet,
      multiple: a.mc_alerte > 0 ? +(sommet / a.mc_alerte).toFixed(2) : null,
      age_minutes: a.age_minutes
    })
  }
  reussis.sort((x, y) => (y.multiple ?? 0) - (x.multiple ?? 0))

  // --- ce qui a échappé, et pourquoi --------------------------------------
  const alertesTropHaut = [...parToken.values()]
    .filter(a => a.mc_alerte !== null && a.mc_alerte > plafond).length
  const alertesSansMontee = [...parToken.values()]
    .filter(a => a.mc_alerte !== null && a.mc_alerte <= plafond
      && (pic.get(a.token) ?? 0) < seuilReussite).length

  return {
    period: new Date().toISOString().slice(0, 10),
    genere_le: new Date(),
    parametres: { plafond_capture: plafond, seuil_reussite: seuilReussite, paliers: PALIERS },

    surveilles: surveilles.length,
    // Tokens dont on connaît la capitalisation de départ : la base de calcul
    // de `montés`. Un token sans premier relevé n'est comptabilisable dans
    // aucun des deux sens.
    depart_connu: [...depart.values()].filter(v => v != null).length,

    explosés,
    montés,
    taux_explosion: Object.fromEntries(PALIERS.map(p =>
      [p, surveilles.length ? +(explosés[p] / surveilles.length * 100).toFixed(3) : 0])),
    // Le taux qui compte : parmi les tokens attrapables, combien ont explosé.
    taux_montee: Object.fromEntries(PALIERS.map(p => {
      const base = [...depart.entries()].filter(([, v]) => v != null && v <= plafond).length
      return [p, base ? +(montés[p] / base * 100).toFixed(2) : 0]
    })),

    alertes_total: alertes.length,
    tokens_alertes: parToken.size,
    reussis: reussis.length,
    // Un token alerté trop haut n'est pas un échec du score : c'est une alerte
    // qu'on n'aurait pas dû envoyer, et c'est ce que `mc_too_high` corrige.
    alertes_trop_haut: alertesTropHaut,
    alertes_sans_montee: alertesSansMontee,
    taux_reussite: parToken.size ? +(reussis.length / parToken.size * 100).toFixed(1) : 0,

    liste: reussis
  }
}

/** Écrit le rapport pour le dashboard. */
export async function run(cfg, opts = {}) {
  const r = await rapport(cfg, opts)
  await col('analytics_succes').updateOne(
    { period: r.period }, { $set: r }, { upsert: true })
  log.info({
    surveilles: r.surveilles, reussis: r.reussis,
    trop_haut: r.alertes_trop_haut, taux: r.taux_reussite
  }, 'M9 — réussites')
  return r
}
