/**
 * Décisions du flux temps réel : l'entrée, et les sorties.
 *
 *   entrée   le token franchit `entry_mc` (50 K) et passe les filtres
 *   ×N       sa capitalisation atteint un multiple de celle de l'entrée
 *   auteurs  plusieurs de ses auteurs se mettent à vendre
 *
 * Les multiples sont ÉCHELONNÉS (×3, ×10, ×30) et non uniques. Le gain de
 * cette stratégie vient d'une distribution à queue épaisse, où le plus gros
 * multiple paie tous les échecs : une sortie unique à ×10 couperait le ×150
 * qui la rend rentable.
 *
 * AUCUN APPEL EXTERNE ICI. Tout le contexte vient du flux : capitalisation et
 * liquidité depuis les réserves du pool, vélocité depuis nos propres trades,
 * auteurs depuis notre registre. Mesuré sur 533 franchissements, ce que
 * Mobula facturait au franchissement ne bloquait plus rien une fois retirés
 * les filtres qui comptent les traders — et son appel ajoutait une seconde
 * de latence au milieu d'une alerte temps réel.
 *
 * Les filtres restent évalués et enregistrés, en MESURE SEULE : M5 doit
 * pouvoir balayer leurs seuils plus tard, ce qu'un filtre simplement supprimé
 * rendrait impossible.
 *
 * Les alertes partent IMMÉDIATEMENT, sans passer par l'étage de livraison du
 * pipeline qui ne tourne que toutes les 5 minutes. Le snapshot porte
 * `source: 'stream'`, que la livraison ignore : rien ne part deux fois.
 */

import { col } from '../../core/db/client.js'
import { mod } from '../../core/logger.js'
import { runFilters } from '../../pipeline/filters/index.js'
import { velocitySnapshot } from '../../pipeline/velocity.js'
import { computeScore, loadDistributions } from '../../pipeline/scoring.js'
import { buildCandidates, buildRawSubscores } from '../../pipeline/stages/trigger.js'
import { openOutcomes } from '../../pipeline/stages/outcome.js'
import { getNotifier } from '../../pipeline/stages/dispatch.js'
import { esc, usd, age } from '../../adapters/notifiers/telegram.js'
import * as triggersRepo from '../../repos/triggers.js'
import * as live from '../../repos/live.js'
import { partMicro, fenetres, auteurs, figerAuteurs } from './state.js'

const log = mod('collector:pump:alertes')

const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`)
const court = w => `${w.slice(0, 4)}…${w.slice(-4)}`

/**
 * Évalue l'entrée d'un token qui vient de franchir `entry_mc`.
 * Appelée une seule fois par token : `entreeEvaluee` est posé avant l'appel.
 */
export async function evaluerEntree(e, { cfg, s, snipers, now = Date.now() }) {
  const tokenId = live.idToken(e.mint)

  // Le snapshot et l'historique du token supposent son document en base.
  if (!e.persiste) { e.persiste = true; await live.persisterToken(e, { configVersion: cfg._id }) }
  const token = await col('tokens').findOne({ _id: tokenId }) ?? {}

  const w = fenetres(e, now, { microUsd: s.microUsd })
  const velocity = velocitySnapshot(w)

  // Auteurs arrêtés au moment de l'entrée : c'est leur sortie qu'on surveille.
  const liste = auteurs(e, { nbPremiers: s.nbAuteurs, estSniper: x => snipers.est(x, now) })
  figerAuteurs(e, liste)

  const mesures = {
    venue: e.gradue ? 'amm' : 'courbe',
    micro_share: partMicro(e),
    micro_sample: e.usdConnus,
    micro_usd: s.microUsd,
    min_sample: s.microMinEchantillon,
    real_buyers_5m: w['5min'].buyersReels,
    real_buyers_total: e.acheteursReels,
    trades: e.n,
    buyers: [...e.wallets.values()].filter(x => x.achats > 0).length,
    liquidity_usd: e.liquiditeUsd,
    complet: e.complet,
    authors: liste,
    authors_share: e.partAuteurs,
    authors_sold_before_entry: e.ventesAuteursAvant,
    sniper_excluded: e.premiers.slice(0, s.nbAuteurs).filter(p => snipers.est(p.wallet, now)).length
  }

  const ctx = {
    _id: tokenId, chain: 'solana', address: e.mint,
    mc: e.mc, threshold_franchi: s.entreeMc,
    velocity,
    holders: token.holders,
    bonding: { ...(token.bonding ?? {}), bonded: e.gradue },
    // Liquidité lue sur les réserves du pool, pas agrégée par un tiers.
    liquidity: { liquidityUsd: e.liquiditeUsd, liquidityBurnPct: null },
    live: mesures
  }

  const rejectionRates = await triggersRepo.rejectionRates()
  const options = { rejectionRates, exclude: s.exclus, mesureSeule: s.mesureSeule }
  const results = []
  let passed = true
  let raison = null

  for (const etage of ['stream', 'deep']) {
    const r = await runFilters(etage, ctx, cfg, options)
    results.push(...r.results)
    if (!r.passed) { passed = false; raison = r.rejectionReason; break }
  }

  const raw = buildRawSubscores({ velocity }, results, token)
  const scored = await computeScore(raw, cfg, { distributions: await loadDistributions() })
  if (passed) {
    const r = await runFilters('score', { _id: tokenId, score: scored.score, coverage: scored.coverage },
      cfg, options)
    results.push(...r.results)
    if (!r.passed) { passed = false; raison = r.rejectionReason }
  }

  const decision = passed ? 'alerted' : 'rejected'
  const ageMin = e.createdAt ? (now - e.createdAt) / 60_000 : null

  const snapshot = await triggersRepo.record({
    token: tokenId,
    chain: 'solana',
    symbol: e.symbol,
    threshold: s.entreeMc,
    config_version: cfg._id,
    source: 'stream',
    context: {
      mc: e.mc,
      age_minutes: ageMin === null ? null : Math.round(ageMin),
      liquidity_aggregate: e.liquiditeUsd,
      velocity,
      live: mesures
    },
    candidates: buildCandidates(token, { velocity }, { mc: e.mc }),
    filters: results,
    decision,
    rejection_reason: decision === 'rejected' ? raison : null,
    score: scored.score,
    subscores: scored.subscores,
    raw_subscores: scored.raw,
    score_method: scored.method,
    weights_used: scored.weightsUsed,
    score_coverage: scored.coverage,
    analysis_source: 'stream'
  })

  if (!snapshot) {
    // Déjà évalué avant un redémarrage : on reprend la décision enregistrée,
    // sans quoi les sorties de ce token ne seraient plus jamais surveillées.
    const ex = await col('trigger_snapshots').findOne({ _id: triggersRepo.triggerId(tokenId, s.entreeMc) })
    if (ex) e.alertes.entree = { decision: ex.decision, mc: ex.context?.mc ?? null, at: +ex.ts, snapshot: ex._id }
    return null
  }

  e.alertes.entree = { decision, mc: e.mc, at: now, snapshot: snapshot._id }
  await triggersRepo.appendToToken(tokenId, { threshold: s.entreeMc, decision, score: scored.score })
  await openOutcomes([snapshot], cfg)

  // Le document du token a été écrit AVANT que les auteurs soient figés et la
  // décision prise : on le réaligne tout de suite plutôt que d'attendre la
  // prochaine écriture périodique. Sans ça, un arrêt dans l'intervalle
  // laisserait en base un token alerté sans trace de son alerte.
  await live.majLive([e]).catch(err => log.warn({ token: tokenId, err: err.message }, 'état non réaligné'))

  log.info({ token: tokenId, symbol: e.symbol, mc: Math.round(e.mc), decision, raison,
    micro: mesures.micro_share, reels: mesures.real_buyers_5m, auteurs: liste.length }, 'entrée évaluée')

  if (decision !== 'alerted') return snapshot

  const texte = [
    `🎯 *${esc(e.symbol ?? '?')}* — ${esc('pump.fun')} · ${esc(age(ageMin))}`,
    `Entrée à *${esc(usd(e.mc))}* de MC · ${esc(e.gradue ? 'PumpSwap' : 'courbe')} · liquidité ${esc(usd(e.liquiditeUsd))}`,
    '',
    `🧪 Trades sous ${esc(usd(s.microUsd))} : *${esc(pct(mesures.micro_share))}* sur ${esc(e.usdConnus)}`,
    `🙋 Acheteurs réels : *${esc(mesures.real_buyers_5m)}* sur 5 min · ${esc(mesures.real_buyers_total)} au total`,
    `👤 ${esc(liste.length)} auteurs${e.partAuteurs === null ? '' : esc(`, ${pct(e.partAuteurs)} de l'offre`)}${e.ventesAuteursAvant ? esc(` (${e.ventesAuteursAvant} déjà vendeurs)`) : ''}`,
    `Score ${esc(scored.score ?? '—')}/100`,
    '',
    `_${esc(`Paliers de sortie : ${(s.multiples ?? []).map(m => 'x' + m).join(', ')} ou ${s.auteursMin} auteurs qui vendent`)}_`
  ].join('\n')

  await envoyer(texte, {
    cfg, tokenId, symbol: e.symbol, kind: 'entry', triggerId: snapshot._id,
    threshold: s.entreeMc, score: scored.score, respecterPlafond: true
  })
  return snapshot
}

/**
 * Alerte de sortie.
 *
 * @param type 'auteurs', ou `x<multiple>` pour un palier atteint.
 *
 * Jamais soumise au plafond horaire : une alerte de sortie retenue parce que
 * le canal est chargé serait pire qu'aucune alerte.
 */
export async function alerterSortie(e, type, { cfg, s }) {
  const tokenId = live.idToken(e.mint)
  const entree = e.alertes.entree
  const multiple = entree?.mc > 0 && e.mc ? e.mc / entree.mc : null
  const palier = type.startsWith('x') ? Number(type.slice(1)) : null
  const seuil = `exit_${type}`
  const vendeurs = [...e.ventesAuteurs.keys()]

  const snapshot = await triggersRepo.record({
    token: tokenId,
    chain: 'solana',
    symbol: e.symbol,
    threshold: seuil,
    config_version: cfg._id,
    source: 'stream',
    context: {
      mc: e.mc,
      mc_entry: entree?.mc ?? null,
      multiple: multiple === null ? null : +multiple.toFixed(2),
      palier,
      minutes_since_entry: entree?.at ? Math.round((Date.now() - entree.at) / 60_000) : null,
      liquidity_usd: e.liquiditeUsd,
      authors_selling: vendeurs,
      authors_total: e.auteursFiges?.length ?? null,
      authors_share: e.partAuteurs
    },
    candidates: {},
    filters: [],
    decision: 'exit',
    rejection_reason: null,
    score: null
  })
  if (!snapshot) return null

  // Le premier palier de la liste est celui qui sécurise la mise ; les
  // suivants accompagnent ce qui reste. Le message le rappelle, parce qu'une
  // alerte « ×30 » lue comme « tout vendre » supprimerait la queue de
  // distribution dont dépend le rendement.
  const premier = (s.multiples ?? [])[0]
  const lignes = palier !== null
    ? [
        `🚀 *${esc(e.symbol ?? '?')}* — palier ×${esc(palier)} atteint`,
        `MC *${esc(usd(e.mc))}* · entrée ${esc(usd(entree?.mc))}${multiple ? esc(` (×${multiple.toFixed(1)})`) : ''}`,
        palier === premier ? `_${esc('Premier palier : sécuriser la mise, laisser courir le reste')}_`
          : `_${esc('Palier suivant : la sortie ferme reste la vente des auteurs')}_`
      ]
    : [
        `⚠️ *${esc(e.symbol ?? '?')}* — ${esc(vendeurs.length)} auteurs vendent`,
        `MC *${esc(usd(e.mc))}*${multiple ? esc(` · ×${multiple.toFixed(1)} depuis l'entrée`) : ''}`,
        esc(vendeurs.slice(0, 5).map(court).join(' · '))
      ]

  await envoyer(lignes.join('\n'), {
    cfg, tokenId, symbol: e.symbol, kind: seuil, triggerId: snapshot._id,
    threshold: seuil, score: null, respecterPlafond: false
  })
  log.info({ token: tokenId, symbol: e.symbol, type, mc: Math.round(e.mc ?? 0), multiple }, 'sortie signalée')
  return snapshot
}

/**
 * Envoi immédiat, sous les mêmes garde-fous que l'étage de livraison :
 * mode calibration, sourdine, plafond horaire.
 */
async function envoyer(texte, { cfg, tokenId, symbol, kind, triggerId, threshold, score, respecterPlafond }) {
  if (!cfg.features?.alerts?.enabled) return { calibration: true }

  const notif = getNotifier()
  if (!notif.available) return { indisponible: true }

  const t = await col('tokens').findOne({ _id: tokenId }, { projection: { muted: 1 } })
  if (t?.muted) return { muet: true }

  if (respecterPlafond) {
    const n = await col('alerts').countDocuments({ sent_at: { $gte: new Date(Date.now() - 3_600_000) } })
    if (n >= (cfg.thresholds?.alert?.max_per_hour ?? 6)) {
      log.warn({ token: tokenId, kind }, 'plafond horaire atteint — alerte retenue')
      return { plafond: true }
    }
  }

  try {
    const r = await notif.sendText(texte, { markdown: true, replyMarkup: notif.buttons({ chain: 'solana', token: tokenId }) })
    await col('alerts').insertOne({
      trigger_id: triggerId,
      token: tokenId,
      chain: 'solana',
      symbol,
      threshold,
      score,
      kind,
      source: 'stream',
      sent_at: new Date(),
      telegram_message_id: r?.message_id ?? null,
      config_version: cfg._id
    })
    return { envoye: true }
  } catch (err) {
    log.error({ token: tokenId, kind, err: err.message }, 'envoi en échec')
    return { echec: err.message }
  }
}
