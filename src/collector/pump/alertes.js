/**
 * Décisions du flux temps réel : l'entrée, et les deux sorties.
 *
 *   entrée   le token franchit `entry_mc` (50 K) et passe les filtres
 *   ×10      sa capitalisation atteint dix fois celle de l'entrée
 *   auteurs  plusieurs de ses auteurs se mettent à vendre
 *
 * L'entrée réutilise la machinerie du déclencheur Mobula — mêmes filtres,
 * même score, même snapshot append-only, mêmes outcomes — avec deux écarts :
 *   - un étage `stream` (micro_trades) passe avant les filtres profonds ;
 *   - les filtres qui lisent le nombre de traders sont exclus, parce qu'un
 *     token manipulé les gonfle par construction.
 *
 * Les alertes partent IMMÉDIATEMENT, sans passer par l'étage de livraison du
 * pipeline qui ne tourne que toutes les 5 minutes. Le snapshot porte
 * `source: 'stream'`, que la livraison ignore : rien ne part deux fois.
 */

import { col } from '../../core/db/client.js'
import { mod } from '../../core/logger.js'
import { getSource } from '../../adapters/sources/index.js'
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

  const velocity = velocitySnapshot(fenetres(e, now))

  // Un appel payant par franchissement, comme le déclencheur Mobula : la
  // liquidité agrégée et la sécurité de la LP ne sont pas dans les journaux.
  let markets = null
  try {
    markets = await getSource(cfg).getTokenMarkets({ chain: 'solana', address: e.mint })
  } catch (err) {
    log.warn({ token: tokenId, err: err.message }, 'analyse Mobula indisponible')
  }
  const agg = markets?.aggregated ?? {}

  const ctx = {
    _id: tokenId, chain: 'solana', address: e.mint,
    mc: e.mc, threshold_franchi: s.entreeMc,
    velocity,
    holders: token.holders,
    bonding: { ...(token.bonding ?? {}), bonded: e.gradue },
    liquidity: { ...agg, liquidityBurnPct: agg.liquidityBurnPct ?? null },
    live: { micro_share: partMicro(e), micro_sample: e.usdConnus, min_sample: s.microMinEchantillon }
  }

  const rejectionRates = await triggersRepo.rejectionRates()
  const results = []
  let passed = true
  let raison = null

  for (const etage of ['stream', 'deep']) {
    const r = await runFilters(etage, ctx, cfg, { rejectionRates, exclude: s.exclus })
    results.push(...r.results)
    if (!r.passed) { passed = false; raison = r.rejectionReason; break }
  }

  const raw = buildRawSubscores({ ...markets, velocity }, results, token)
  const scored = await computeScore(raw, cfg, { distributions: await loadDistributions() })
  if (passed) {
    const r = await runFilters('score', { _id: tokenId, score: scored.score, coverage: scored.coverage },
      cfg, { exclude: s.exclus })
    results.push(...r.results)
    if (!r.passed) { passed = false; raison = r.rejectionReason }
  }

  // Auteurs arrêtés au moment de l'entrée : c'est leur sortie qu'on surveille.
  const liste = auteurs(e, { nbPremiers: s.nbAuteurs, estSniper: w => snipers.est(w, now) })
  figerAuteurs(e, liste)

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
      liquidity_aggregate: agg.liquidityUsd ?? null,
      velocity,
      live: {
        venue: e.gradue ? 'amm' : 'courbe',
        micro_share: partMicro(e),
        micro_sample: e.usdConnus,
        trades: e.n,
        buyers: [...e.wallets.values()].filter(w => w.achats > 0).length,
        complet: e.complet,
        authors: liste,
        authors_sold_before_entry: e.ventesAuteursAvant,
        sniper_excluded: e.premiers.slice(0, s.nbAuteurs).filter(p => snipers.est(p.wallet, now)).length
      }
    },
    candidates: buildCandidates(token, { ...markets, velocity }, { mc: e.mc }),
    filters: results,
    decision,
    rejection_reason: decision === 'rejected' ? raison : null,
    score: scored.score,
    subscores: scored.subscores,
    raw_subscores: scored.raw,
    score_method: scored.method,
    weights_used: scored.weightsUsed,
    score_coverage: scored.coverage,
    analysis_source: markets?.source ?? null
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

  log.info({ token: tokenId, symbol: e.symbol, mc: Math.round(e.mc), decision, raison,
    micro: partMicro(e), auteurs: liste.length }, 'entrée évaluée')

  if (decision !== 'alerted') return snapshot

  const w5 = velocity
  const texte = [
    `🎯 *${esc(e.symbol ?? '?')}* — ${esc('pump.fun')} · ${esc(age(ageMin))}`,
    `Entrée à *${esc(usd(e.mc))}* de MC · ${esc(e.gradue ? 'PumpSwap' : 'courbe')}`,
    '',
    `🧪 Trades sous ${esc(usd(s.microUsd))} : *${esc(pct(partMicro(e)))}* sur ${esc(e.usdConnus)}`,
    `👥 5 min : ${esc(w5.buyers ?? '—')} acheteurs · ${esc(w5.buys ?? '—')} achats / ${esc(w5.sells ?? '—')} ventes`,
    `👤 ${esc(liste.length)} auteurs surveillés${e.ventesAuteursAvant ? esc(` (dont ${e.ventesAuteursAvant} déjà vendeurs)`) : ''}`,
    `Score ${esc(scored.score ?? '—')}/100`,
    '',
    `_${esc(`Sortie : ×${s.multipleSortie} ou ${s.auteursMin} auteurs qui vendent`)}_`
  ].join('\n')

  await envoyer(texte, {
    cfg, tokenId, symbol: e.symbol, kind: 'entry', triggerId: snapshot._id,
    threshold: s.entreeMc, score: scored.score, respecterPlafond: true
  })
  return snapshot
}

/**
 * Alerte de sortie. Jamais soumise au plafond horaire : une alerte de dump
 * retenue parce que le canal est chargé serait pire qu'aucune alerte.
 */
export async function alerterSortie(e, type, { cfg, s }) {
  const tokenId = live.idToken(e.mint)
  const entree = e.alertes.entree
  const multiple = entree?.mc > 0 && e.mc ? e.mc / entree.mc : null
  const seuil = type === 'x10' ? 'exit_x10' : 'exit_authors'
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
      minutes_since_entry: entree?.at ? Math.round((Date.now() - entree.at) / 60_000) : null,
      authors_selling: vendeurs,
      authors_total: e.auteursFiges?.length ?? null
    },
    candidates: {},
    filters: [],
    decision: 'exit',
    rejection_reason: null,
    score: null
  })
  if (!snapshot) return null

  const lignes = type === 'x10'
    ? [
        `🚀 *${esc(e.symbol ?? '?')}* — ×${esc(s.multipleSortie)} atteint`,
        `MC *${esc(usd(e.mc))}* · entrée ${esc(usd(entree?.mc))}${multiple ? esc(` (×${multiple.toFixed(1)})`) : ''}`
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
