/**
 * M10 — la thèse a-t-elle raison, et où a-t-elle tort ?
 *
 * Les autres modules mesurent le système. Celui-ci met à l'épreuve la
 * STRATÉGIE elle-même, en quatre questions dont dépend tout le reste :
 *
 *   1. la part de micro-trades sépare-t-elle les tokens qui montent des
 *      autres ? Si les deux distributions se superposent, la thèse tombe.
 *   2. l'arrivée de vrais acheteurs sépare-t-elle mieux ?
 *   3. combien d'AVANCE donne la première vente d'un auteur sur
 *      l'effondrement ? C'est ce qui décide entre sortie sur signal et
 *      sortie mécanique. Si l'avance est nulle, le signal ne vaut rien.
 *   4. quelle espérance de gain en découle, politique de sortie par
 *      politique de sortie ?
 *
 * Le pouvoir séparateur se lit en AUC (aire sous la courbe ROC), calculée par
 * rangs : 0,5 signifie « aucun signal », 1 « séparation parfaite ». Une
 * moyenne plus élevée chez les gagnants ne prouve rien si les distributions
 * se chevauchent ; l'AUC, si.
 *
 * Rien n'est inventé : chaque section refuse de conclure sous un effectif
 * minimal et le dit (`insuffisant`). Un faux chiffre serait pire que pas de
 * chiffre, parce qu'il déciderait.
 */

import { col } from '../core/db/client.js'
import { mod } from '../core/logger.js'

const log = mod('m10')

/** Sous cet effectif dans l'un des deux groupes, on ne conclut pas. */
const MIN_GROUPE = 10

const mediane = a => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
const quantile = (a, p) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const moyenne = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

/**
 * AUC par rangs (statistique de Mann-Whitney), égalités comprises.
 * @returns {number|null} 0-1, ou null si un groupe est trop petit
 */
export function auc(gagnants, perdants) {
  if (gagnants.length < MIN_GROUPE || perdants.length < MIN_GROUPE) return null
  const tous = [...gagnants.map(v => ({ v, g: 1 })), ...perdants.map(v => ({ v, g: 0 }))]
    .sort((a, b) => a.v - b.v)

  // Rangs moyens sur les égalités, sinon une valeur très fréquente (0, par
  // exemple) fausserait la statistique.
  let i = 0
  let sommeRangs = 0
  while (i < tous.length) {
    let j = i
    while (j + 1 < tous.length && tous[j + 1].v === tous[i].v) j++
    const rangMoyen = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) if (tous[k].g === 1) sommeRangs += rangMoyen
    i = j + 1
  }
  const n1 = gagnants.length, n2 = perdants.length
  return +((sommeRangs - n1 * (n1 + 1) / 2) / (n1 * n2)).toFixed(3)
}

/** Compare une mesure entre deux groupes, avec son pouvoir séparateur. */
function comparer(nom, gagnants, perdants) {
  const a = auc(gagnants, perdants)
  return {
    mesure: nom,
    gagnants: gagnants.length,
    perdants: perdants.length,
    mediane_gagnants: mediane(gagnants),
    mediane_perdants: mediane(perdants),
    auc: a,
    verdict: a === null ? 'insuffisant'
      : a >= 0.65 ? 'sépare'
        : a >= 0.55 ? 'faible'
          : a <= 0.35 ? 'sépare en sens INVERSE'
            : 'aucun signal'
  }
}

/**
 * Population du flux : ce qu'on a vu, et ce qu'on en a fait.
 * `monte` : le token a fait au moins `multipleMontee` fois sa capitalisation
 * la plus basse mesurée — la définition la plus large possible, pour ne pas
 * présumer du point d'entrée.
 */
export async function population({ multipleMontee = 3 } = {}) {
  const docs = await col('tokens').find(
    { 'live.source': 'stream' },
    { projection: { symbol: 1, live: 1, triggers: 1, created_at: 1 } }
  ).toArray()

  const tokens = docs.map(d => {
    const l = d.live ?? {}
    const bas = l.mc ?? null
    const haut = l.mc_max ?? null
    return {
      id: d._id,
      symbol: d.symbol,
      micro: l.micro_share ?? null,
      echantillon: l.micro_sample ?? 0,
      acheteursReels: l.real_buyers ?? null,
      liquidite: l.liquidity_usd ?? null,
      partAuteurs: l.authors_share ?? null,
      gradue: Boolean(l.graduated),
      mcMax: haut,
      entree: l.alerts?.entry ?? null,
      multiple: haut && bas ? haut / Math.max(bas, 1) : null,
      monte: Boolean(haut && haut >= (bas ?? haut) * multipleMontee)
    }
  })

  return {
    tokens,
    vus: tokens.length,
    gradues: tokens.filter(t => t.gradue).length,
    evalues: tokens.filter(t => t.entree).length,
    alertes: tokens.filter(t => t.entree?.decision === 'alerted').length,
    rejetes: tokens.filter(t => t.entree?.decision === 'rejected').length,
    montes: tokens.filter(t => t.monte).length
  }
}

/**
 * Question 3 : quelle avance donne la première vente d'un auteur ?
 *
 * On cherche, dans les trades postérieurs à l'alerte de sortie, le premier
 * instant où la capitalisation passe sous la moitié puis sous le cinquième de
 * celle du signal. L'écart est le temps dont on disposait réellement.
 */
export async function avanceSignal() {
  const sorties = await col('trigger_snapshots').find(
    { source: 'stream', decision: 'exit', threshold: 'exit_auteurs' },
    { projection: { token: 1, ts: 1, 'context.mc': 1 } }
  ).toArray()

  const delais = { moitie: [], cinquieme: [] }
  let sansChute = 0
  let sansTrades = 0

  for (const s of sorties) {
    const mcSignal = s.context?.mc
    if (!mcSignal) continue
    const apres = await col('trades').find(
      { token: s.token, ts: { $gt: s.ts }, mc_usd: { $ne: null } },
      { projection: { ts: 1, mc_usd: 1 } }
    ).sort({ ts: 1 }).toArray()

    if (!apres.length) { sansTrades++; continue }
    const moitie = apres.find(t => t.mc_usd <= mcSignal * 0.5)
    const cinquieme = apres.find(t => t.mc_usd <= mcSignal * 0.2)
    if (!moitie) { sansChute++; continue }
    delais.moitie.push((+moitie.ts - +s.ts) / 1000)
    if (cinquieme) delais.cinquieme.push((+cinquieme.ts - +s.ts) / 1000)
  }

  const resume = a => (a.length < MIN_GROUPE ? null : {
    n: a.length,
    mediane_s: Math.round(mediane(a)),
    p25_s: Math.round(quantile(a, 0.25)),
    p75_s: Math.round(quantile(a, 0.75))
  })

  return {
    signaux: sorties.length,
    sans_trades_apres: sansTrades,
    jamais_tombe_de_moitie: sansChute,
    avant_moitie: resume(delais.moitie),
    avant_cinquieme: resume(delais.cinquieme),
    verdict: delais.moitie.length < MIN_GROUPE ? 'insuffisant'
      : mediane(delais.moitie) >= 60 ? 'le signal laisse le temps de sortir'
        : 'le signal arrive trop tard — sortie mécanique à préférer'
  }
}

/**
 * Question 4 : l'espérance, politique de sortie par politique de sortie.
 *
 * Pour chaque token alerté, on rejoue sa série de capitalisations APRÈS
 * l'alerte et on applique chaque politique :
 *   - `paliers`     vend une fraction à chaque multiple atteint, le reste au
 *                   signal des auteurs (ou au dernier prix connu)
 *   - `fixe_N`      vend tout au multiple N
 *   - `auteurs`     vend tout au signal des auteurs
 *
 * L'espérance est donnée par unité investie : 0 signifie qu'on rend sa mise.
 */
export async function esperance(cfg, { paliers = null } = {}) {
  const multiples = paliers ?? cfg?.thresholds?.stream?.exit_multiples ?? [3, 10, 30]
  const alertes = await col('trigger_snapshots').find(
    { source: 'stream', decision: 'alerted' },
    { projection: { token: 1, ts: 1, 'context.mc': 1, symbol: 1 } }
  ).toArray()

  const politiques = {}
  const enregistre = (nom, valeur) => ((politiques[nom] ??= []).push(valeur))
  const lignes = []

  for (const a of alertes) {
    const mcEntree = a.context?.mc
    if (!mcEntree) continue

    const serie = await col('trades').find(
      { token: a.token, ts: { $gte: a.ts }, mc_usd: { $ne: null } },
      { projection: { ts: 1, mc_usd: 1 } }
    ).sort({ ts: 1 }).toArray()
    if (!serie.length) continue

    const sortie = await col('trigger_snapshots').findOne(
      { token: a.token, decision: 'exit', threshold: 'exit_auteurs' }, { projection: { ts: 1 } })

    const mcFinal = serie.at(-1).mc_usd
    const mcAuteurs = sortie
      ? (serie.find(t => t.ts >= sortie.ts)?.mc_usd ?? mcFinal)
      : mcFinal
    // `Math.max(...tableau)` déborde la pile au-delà de quelques dizaines de
    // milliers d'éléments, et une série de trades les dépasse largement.
    const sommet = serie.reduce((m, t) => (t.mc_usd > m ? t.mc_usd : m), 0)

    // Politique « auteurs » : on sort au signal, sinon au dernier prix connu.
    const rAuteurs = mcAuteurs / mcEntree
    enregistre('auteurs', rAuteurs)

    // Politiques à multiple fixe : atteint ou non.
    for (const m of multiples) {
      enregistre(`fixe_x${m}`, sommet >= mcEntree * m ? m : rAuteurs)
    }

    // Politique échelonnée : une fraction égale à chaque palier atteint, le
    // solde au signal des auteurs.
    const parts = multiples.length + 1
    let gain = 0
    let restant = parts
    for (const m of multiples) {
      if (sommet >= mcEntree * m) { gain += m / parts; restant-- }
    }
    gain += rAuteurs * (restant / parts)
    enregistre('echelonnee', gain)

    lignes.push({
      token: a.token, symbol: a.symbol,
      mc_entree: Math.round(mcEntree),
      sommet: Math.round(sommet),
      multiple_max: +(sommet / mcEntree).toFixed(2),
      sortie_auteurs: +rAuteurs.toFixed(2),
      echelonnee: +gain.toFixed(2)
    })
  }

  const resume = {}
  for (const [nom, valeurs] of Object.entries(politiques)) {
    resume[nom] = valeurs.length < MIN_GROUPE ? { n: valeurs.length, verdict: 'insuffisant' } : {
      n: valeurs.length,
      // Espérance par unité investie : la moyenne des multiples, moins la mise.
      esperance: +(moyenne(valeurs) - 1).toFixed(3),
      mediane: +mediane(valeurs).toFixed(2),
      gagnants: valeurs.filter(v => v > 1).length,
      taux_gagnants: +(valeurs.filter(v => v > 1).length / valeurs.length).toFixed(3)
    }
  }

  lignes.sort((a, b) => b.multiple_max - a.multiple_max)
  return { alertes: alertes.length, politiques: resume, tokens: lignes.slice(0, 50) }
}

/**
 * Balayage des seuils d'entrée : combien d'entrées, et quelle espérance,
 * chaque seuil aurait produit. Repose sur les valeurs MESURÉES enregistrées
 * dans les snapshots — c'est précisément ce que la mesure seule préserve.
 */
export async function balayage() {
  const snaps = await col('trigger_snapshots').find(
    { source: 'stream', decision: { $in: ['alerted', 'rejected'] } },
    { projection: { token: 1, 'context.live': 1, 'context.mc': 1 } }
  ).toArray()

  const tokens = await col('tokens').find(
    { _id: { $in: snaps.map(s => s.token) } },
    { projection: { 'live.mc_max': 1 } }
  ).toArray()
  const sommets = new Map(tokens.map(t => [t._id, t.live?.mc_max ?? null]))

  const lignes = []
  for (const champ of ['micro_share', 'real_buyers_5m']) {
    const seuils = champ === 'micro_share' ? [0, 0.5, 0.6, 0.7, 0.8, 0.9] : [0, 1, 3, 5, 10]
    for (const seuil of seuils) {
      const retenus = snaps.filter(s => (s.context?.live?.[champ] ?? -1) >= seuil)
      const multiples = retenus
        .map(s => {
          const sommet = sommets.get(s.token)
          return sommet && s.context?.mc ? sommet / s.context.mc : null
        })
        .filter(v => v !== null)
      lignes.push({
        champ, seuil,
        entrees: retenus.length,
        esperance: multiples.length < MIN_GROUPE ? null : +(moyenne(multiples) - 1).toFixed(3),
        multiple_median: multiples.length < MIN_GROUPE ? null : +mediane(multiples).toFixed(2)
      })
    }
  }
  return lignes
}

/**
 * Montées organiques : chaque croisement mesuré et ce que le token est
 * devenu. Gagnant : sommet ≥ `multipleGagnant` fois la capitalisation au
 * croisement. Pour chaque seuil, l'entonnoir puis le pouvoir séparateur de
 * chaque signal, les plus séparateurs en tête.
 *
 * Le sommet est `live.mc_max`. Un croisement retenu est une montée (sommet au
 * plus 3× le seuil à cet instant), donc le sommet final lui est postérieur.
 * Les croisements de moins de `reculHeures` sont écartés : leur token n'a pas
 * fini de monter ou de mourir.
 */
export async function organiques({ multipleGagnant = 3, reculHeures = 6 } = {}) {
  const croisements = await col('stream_crossings')
    .find({ ts: { $lte: new Date(Date.now() - reculHeures * 3_600_000) } }).toArray()
  const toks = await col('tokens').find({ _id: { $in: [...new Set(croisements.map(c => c.token))] } },
    { projection: { 'live.mc_max': 1, 'live.graduated': 1 } }).toArray()
  const parId = new Map(toks.map(t => [t._id, t.live ?? {}]))

  const instants = croisements.map(c => +c.ts)
  const jours = instants.length > 1
    ? (instants.reduce((m, v) => Math.max(m, v), 0) - instants.reduce((m, v) => Math.min(m, v), Infinity)) / 86_400_000
    : 0
  const num = v => (typeof v === 'boolean' ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null)

  const seuils = []
  for (const seuil of [...new Set(croisements.map(c => c.seuil))].sort((a, b) => a - b)) {
    const lignes = croisements.filter(c => c.seuil === seuil).map(c => {
      const l = parId.get(c.token) ?? {}
      const valeurs = { ...c.signaux }
      for (const [k, v] of Object.entries(c.createur ?? {})) valeurs[`createur_${k}`] = v
      delete valeurs.mc
      return { valeurs, sommet: l.mc_max ?? null, gradue: Boolean(l.graduated),
        multiple: l.mc_max && c.signaux?.mc ? l.mc_max / c.signaux.mc : null }
    }).filter(x => x.multiple !== null)

    const n = lignes.length
    const taux = f => (n ? +(lignes.filter(f).length / n).toFixed(3) : null)
    const gagnants = lignes.filter(x => x.multiple >= multipleGagnant)
    const perdants = lignes.filter(x => x.multiple < multipleGagnant)
    const noms = [...new Set(lignes.flatMap(x => Object.keys(x.valeurs)))]
    const separation = noms
      .map(k => comparer(k,
        gagnants.map(x => num(x.valeurs[k])).filter(v => v !== null),
        perdants.map(x => num(x.valeurs[k])).filter(v => v !== null)))
      .sort((a, b) => Math.abs((b.auc ?? 0.5) - 0.5) - Math.abs((a.auc ?? 0.5) - 0.5))

    seuils.push({
      seuil,
      croisements: n,
      par_jour: jours ? Math.round(n / jours) : null,
      gradue: taux(x => x.gradue),
      x2: taux(x => x.multiple >= 2),
      x3: taux(x => x.multiple >= 3),
      x10: taux(x => x.multiple >= 10),
      au_dessus_100k: taux(x => x.sommet >= 100_000),
      au_dessus_1m: taux(x => x.sommet >= 1_000_000),
      multiple_median: n ? +mediane(lignes.map(x => x.multiple)).toFixed(2) : null,
      separation
    })
  }
  return { recul_heures: reculHeures, multiple_gagnant: multipleGagnant, seuils }
}

/**
 * Tokens d'usine : graduation dans la seconde de la création. Observés, jamais
 * alertés — pour voir s'ils changent de forme (rythme, taille du saut, acteurs
 * récurrents) et à quelle vitesse ils retombent après le saut.
 *
 * Les tokens gradués avant le marquage `live.factory` sont classés sur le
 * délai création → graduation, qui est la même définition.
 */
export async function usine({ maxSecondes = 2 } = {}) {
  const docs = await col('tokens').find(
    { 'live.source': 'stream', 'live.complet': true, 'live.graduated': true, created_at: { $ne: null } },
    { projection: { created_at: 1, deployer: 1, 'live.factory': 1, 'live.graduated_at': 1, 'live.mc_max': 1,
      'live.mc_max_at': 1, 'live.first_halving': 1, 'live.first_buyers': 1 } }
  ).toArray()

  const estUsine = d => {
    if (typeof d.live.factory === 'boolean') return d.live.factory
    if (!d.live.graduated_at) return null
    return (+d.live.graduated_at - +d.created_at) / 1000 <= maxSecondes
  }
  const classes = docs.filter(d => estUsine(d) !== null)
  const fab = classes.filter(d => estUsine(d))

  const parJour = {}
  for (const d of fab) {
    const j = new Date(d.created_at).toISOString().slice(0, 10)
    parJour[j] = (parJour[j] ?? 0) + 1
  }
  const sommets = fab.map(d => d.live.mc_max).filter(v => v > 0)
  const versSommet = fab
    .map(d => (d.live.mc_max_at ? (+d.live.mc_max_at - +d.created_at) / 1000 : null))
    .filter(v => v !== null && v >= 0)
  const versMoitie = fab
    .map(d => (d.live.first_halving?.at && d.live.first_halving?.peak_at
      ? (+d.live.first_halving.at - +d.live.first_halving.peak_at) / 1000 : null))
    .filter(v => v !== null && v >= 0)

  const recurrents = liste => {
    const n = new Map()
    for (const x of liste) n.set(x, (n.get(x) ?? 0) + 1)
    return [...n.entries()].filter(([, k]) => k >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, tokens]) => ({ id, tokens }))
  }

  return {
    gradues_classes: classes.length,
    usine: fab.length,
    part_usine: classes.length ? +(fab.length / classes.length).toFixed(3) : null,
    par_jour: parJour,
    sommet_median: sommets.length ? Math.round(mediane(sommets)) : null,
    sommet_p75: sommets.length ? Math.round(quantile(sommets, 0.75)) : null,
    au_dessus_1m: fab.filter(d => d.live.mc_max >= 1_000_000).length,
    secondes_vers_sommet_mediane: versSommet.length >= MIN_GROUPE ? Math.round(mediane(versSommet)) : null,
    secondes_sommet_vers_moitie_mediane: versMoitie.length >= MIN_GROUPE ? Math.round(mediane(versMoitie)) : null,
    mesures_de_chute: versMoitie.length,
    createurs_recurrents: recurrents(fab.map(d => d.deployer).filter(Boolean)),
    // Les premiers acheteurs d'un token d'usine sont ceux du saut : leur
    // récurrence d'un token à l'autre dit si l'usine tourne avec les mêmes wallets.
    premiers_acheteurs_recurrents: recurrents(fab.flatMap(d => (d.live.first_buyers ?? []).map(b => b.wallet)))
  }
}

/** Rapport complet. */
export async function rapport(cfg) {
  const pop = await population()
  const mesurables = pop.tokens.filter(t => t.micro !== null && t.echantillon >= 20)
  const gagnants = mesurables.filter(t => t.monte)
  const perdants = mesurables.filter(t => !t.monte)

  const gaps = await col('stream_gaps').countDocuments({})
  const secondesPerdues = (await col('stream_gaps').aggregate([
    { $group: { _id: null, s: { $sum: '$duree_s' } } }
  ]).toArray())[0]?.s ?? 0

  return {
    period: new Date().toISOString().slice(0, 10),
    genere_le: new Date(),

    population: { vus: pop.vus, gradues: pop.gradues, evalues: pop.evalues,
      alertes: pop.alertes, rejetes: pop.rejetes, montes: pop.montes },

    // Qualité de la collecte : une conclusion tirée sur une période trouée
    // n'a pas la même valeur, et il faut pouvoir le dire.
    collecte: { coupures: gaps, secondes_perdues: secondesPerdues },

    separation: [
      comparer('part de micro-trades', gagnants.map(t => t.micro), perdants.map(t => t.micro)),
      comparer('acheteurs réels', gagnants.map(t => t.acheteursReels ?? 0), perdants.map(t => t.acheteursReels ?? 0)),
      comparer('liquidité', gagnants.map(t => t.liquidite ?? 0), perdants.map(t => t.liquidite ?? 0)),
      comparer('part détenue par les auteurs',
        gagnants.filter(t => t.partAuteurs !== null).map(t => t.partAuteurs),
        perdants.filter(t => t.partAuteurs !== null).map(t => t.partAuteurs))
    ],

    avance_signal: await avanceSignal(),
    esperance: await esperance(cfg),
    balayage: await balayage(),
    organiques: await organiques(),
    usine: await usine()
  }
}

/** Écrit le rapport pour le dashboard. */
export async function run(cfg, opts = {}) {
  const r = await rapport(cfg, opts)
  await col('analytics_strategie').updateOne({ period: r.period }, { $set: r }, { upsert: true })
  log.info({
    vus: r.population.vus, alertes: r.population.alertes, montes: r.population.montes,
    micro_auc: r.separation[0]?.auc, avance: r.avance_signal?.verdict,
    croisements: r.organiques.seuils.map(s => `${s.seuil}:${s.croisements}`).join(' '),
    usine: r.usine.usine, part_usine: r.usine.part_usine
  }, 'M10 — mise à l\'épreuve de la stratégie')
  return r
}
