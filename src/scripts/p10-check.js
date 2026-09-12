/**
 * P10 — flux temps réel pump.fun : décodage, état, décisions, filtrage.
 *
 * Aucun réseau. Le décodage est vérifié sur de VRAIS journaux capturés sur le
 * mainnet (fixtures/pump-logs.json) ; l'état et les décisions sur des
 * séquences de trades construites à la main, où l'on sait ce qui doit sortir.
 *
 * Usage : npm run p10
 */

import { readFileSync } from 'node:fs'
import { decoderEvenement, normaliser, evenementsDesLogs } from '../collector/pump/decode.js'
import { creerEtat, appliquerTrade, partMicro, partDetenue, fenetres, auteurs, figerAuteurs,
  decisions, peutEvaluerEntree, paliersDus, multipleAtteint, Snipers } from '../collector/pump/state.js'
import microTrades from '../pipeline/filters/stream/micro_trades.js'
import realBuyers from '../pipeline/filters/stream/real_buyers.js'
import { filtersFor, runFilters } from '../pipeline/filters/index.js'
import { reglages } from '../collector/pump/stream.js'

let ok = 0
let ko = 0
const verifier = (cond, msg) => {
  if (cond) { ok++; console.log(`  ✓ ${msg}`) } else { ko++; console.log(`  ✗ ${msg}`) }
}

// --- 1. décodage sur journaux réels -----------------------------------------------

console.log('\n1. Décodage des journaux réels')
const fx = JSON.parse(readFileSync(new URL('./fixtures/pump-logs.json', import.meta.url), 'utf8'))

let lignes = 0, reconnues = 0, tronques = 0, exceptions = 0
const parNom = {}
const conv = { courbe: { avant: 0, apres: 0 }, amm: { avant: 0, apres: 0 } }
const trades = []
let buyEvt = null

function juger(cible, eff, r, achat) {
  if (Math.abs(eff / r - 1) < 0.02) return          // trop petit pour trancher
  const avant = achat ? eff > r : eff < r
  conv[cible][avant ? 'avant' : 'apres']++
}

for (const prog of ['pump', 'pump_amm']) {
  for (const tx of fx[prog]) {
    for (const b64 of tx.data) {
      lignes++
      let e
      try { e = decoderEvenement(b64) } catch { exceptions++; continue }
      if (!e) continue
      reconnues++
      parNom[e.nom] = (parNom[e.nom] ?? 0) + 1
      if (e.data._tronque) tronques++
      const d = e.data
      if (e.nom === 'TradeEvent') {
        trades.push(normaliser(e))
        if (d.token_amount > 0 && d.sol_amount > 0) {
          juger('courbe', d.sol_amount / d.token_amount, d.virtual_sol_reserves / d.virtual_token_reserves, d.is_buy)
        }
      }
      if (e.nom === 'BuyEvent') {
        buyEvt ??= e
        if (d.base_amount_out > 0) juger('amm', d.quote_amount_in / d.base_amount_out, d.pool_quote_token_reserves / d.pool_base_token_reserves, true)
      }
      if (e.nom === 'SellEvent' && d.base_amount_in > 0) {
        juger('amm', d.quote_amount_out / d.base_amount_in, d.pool_quote_token_reserves / d.pool_base_token_reserves, false)
      }
    }
  }
}

verifier(exceptions === 0, `aucune exception sur ${lignes} lignes Program data`)
// La capture garde 40 transactions par programme ; les lignes non reconnues
// sont des événements qu'on n'écoute pas (une vingtaine de types par programme).
verifier(reconnues >= 60, `${reconnues} événements reconnus (${JSON.stringify(parNom)})`)
verifier(tronques === 0, 'aucun événement tronqué')
verifier((parNom.TradeEvent ?? 0) >= 20 && (parNom.BuyEvent ?? 0) + (parNom.SellEvent ?? 0) >= 20,
  'trades présents sur la courbe ET sur PumpSwap')

const tauxApres = conv.courbe.apres / Math.max(1, conv.courbe.avant + conv.courbe.apres)
verifier(tauxApres >= 0.9, `courbe : réserves APRÈS le trade (${conv.courbe.apres} contre ${conv.courbe.avant})`)
const tauxAvant = conv.amm.avant / Math.max(1, conv.amm.avant + conv.amm.apres)
verifier(tauxAvant >= 0.85, `PumpSwap : réserves AVANT le trade (${conv.amm.avant} contre ${conv.amm.apres})`)

// Pump.fun cote désormais certains tokens dans d'autres monnaies que le SOL.
// Pour ceux-là on ne connaît pas le cours : le décodeur doit rendre `null`,
// jamais un prix calculé comme si c'était du SOL.
const enSol = trades.filter(t => t.quote === 'SOL' || t.quote === 'USDC')
const autres = trades.filter(t => t.quote === null)
verifier(enSol.every(t => ['buy', 'sell'].includes(t.cote) && t.tokens > 0 && t.prix > 0 && t.montant >= 0),
  `${enSol.length} trades cotés en SOL : sens, quantité, prix et montant complets`)
verifier(autres.every(t => t.prix === null && t.montant === null && t.tokens > 0),
  `${autres.length} trades cotés dans une autre monnaie : prix et montant laissés inconnus`)
verifier(enSol.length + autres.length === trades.length, 'chaque trade de courbe est classé')

// Les réserves RÉELLES remplacent la liquidité que Mobula facturait.
const avecReserve = enSol.filter(t => t.reserveQuote !== null && t.reserveQuote !== undefined)
verifier(avecReserve.length >= enSol.length * 0.9 && avecReserve.every(t => t.reserveQuote >= 0),
  `${avecReserve.length}/${enSol.length} trades de courbe portent la réserve réelle du pool`)

const an = new Date(trades[0]?.ts).getUTCFullYear()
verifier(an >= 2025 && an <= 2030, `horodatage plausible (${an})`)
verifier(trades.filter(t => t.mint.endsWith('pump')).length / trades.length >= 0.8, 'mints au suffixe pump.fun')
verifier(trades.every(t => typeof t.creator === 'string' && t.creator.length >= 32), 'créateur présent dans chaque trade')

// Pool inconnu, puis connu
verifier(normaliser(buyEvt)?.type === 'pool_inconnu', 'trade PumpSwap sur pool inconnu : à résoudre')
const pools = new Map([[buyEvt.data.pool, { mint: 'MintTestpump', quoteMint: 'So11111111111111111111111111111111111111112' }]])
const amm = normaliser(buyEvt, { pools })
verifier(amm.type === 'trade' && amm.mint === 'MintTestpump' && amm.cote === 'buy' && amm.prix > 0,
  'trade PumpSwap relié à son mint une fois le pool connu')
verifier(amm.reserveQuote > 0 && amm.reserveBase > 0, 'réserves du pool PumpSwap ramenées après le trade')

// Pool inversé : le SOL est le token de base, donc la paire cote autre chose.
const inverse = new Map([[buyEvt.data.pool, { mint: 'So11111111111111111111111111111111111111112', quoteMint: 'AutreTokenQuelconque11111111111111111111111' }]])
verifier(normaliser(buyEvt, { pools: inverse })?.type === 'pool_inverse',
  'pool inversé (SOL en base) : écarté au lieu d\'être lu à l\'envers')
verifier(evenementsDesLogs(['Program log: Instruction: Buy', 'Program data: !!!', 'Program data: AAAA']).length === 0,
  'lignes illisibles ignorées sans exception')

// Attribution par la pile d'appels : un discriminant Anchor ne dépend que du
// NOM de l'événement, donc un programme étranger nommant le sien `TradeEvent`
// produit le même préfixe. La charge ci-dessous est un VRAI TradeEvent
// pump.fun ; elle ne doit être lue que sous pump.fun.
const charge = fx.pump.flatMap(tx => tx.data).find(b => decoderEvenement(b)?.nom === 'TradeEvent')
const PUMP_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const ETRANGER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
verifier(evenementsDesLogs([
  `Program ${PUMP_ID} invoke [1]`, `Program data: ${charge}`, `Program ${PUMP_ID} success`
]).length === 1, 'événement émis par pump.fun : accepté')
verifier(evenementsDesLogs([
  `Program ${ETRANGER} invoke [1]`, `Program data: ${charge}`, `Program ${ETRANGER} success`
]).length === 0, 'même charge émise par un programme étranger : ignorée')
verifier(evenementsDesLogs([
  `Program ${ETRANGER} invoke [1]`, `Program ${PUMP_ID} invoke [2]`, `Program data: ${charge}`,
  `Program ${PUMP_ID} success`, `Program data: ${charge}`, `Program ${ETRANGER} success`
]).length === 1, 'appel imbriqué : seul l\'événement écrit sous pump.fun est retenu')
verifier(evenementsDesLogs([`Program data: ${charge}`]).length === 0,
  'ligne sans pile d\'appels : ignorée plutôt que devinée')

// --- 2. état et décisions ------------------------------------------------------------

console.log('\n2. État et décisions')
const S = { entreeMc: 50_000, multiples: [3, 10, 30], auteursMin: 2 }
const t0 = Date.parse('2026-09-11T12:00:00Z')
const opts = (min = 0) => ({ maxPremiers: 20, microUsd: 1, now: t0 + min * 60_000 })
const trade = (wallet, cote, usd, mc, min = 0) => ({ ts: t0 + min * 60_000, wallet, cote, tokens: 1000, usd, prixUsd: mc / 1e9, mcUsd: mc, venue: 'courbe' })
// Marque les paliers franchis, comme le fait le flux après avoir alerté.
const marquer = (e) => { for (const m of paliersDus(e, S.multiples)) e.alertes.multiples.push({ multiple: m, at: t0, mc: e.mc }) }

const e = creerEtat({ mint: 'M', creator: 'DEV', createdAt: t0, vuA: t0 })
appliquerTrade(e, trade('DEV', 'buy', 50, 3_000), opts())
for (let k = 1; k <= 12; k++) appliquerTrade(e, trade(`W${k}`, 'buy', 0.3, 3_000 + k * 100, k / 10), opts(k / 10))
for (let k = 1; k <= 3; k++) appliquerTrade(e, trade(`R${k}`, 'buy', 40, 6_000 + k * 1000, 2), opts(2))

verifier(e.premiers.length === 16 && e.premiers[0].wallet === 'DEV' && e.premiers[1].wallet === 'W1',
  'premiers acheteurs distincts, dans l\'ordre')
verifier(Math.abs(partMicro(e) - 12 / 16) < 1e-9, `part de micro-trades exacte (${partMicro(e)})`)
verifier(e.acheteursReels === 4, `acheteurs réels comptés (${e.acheteursReels} : DEV et R1 à R3)`)
verifier(decisions(e, S).length === 0, 'sous 50 K : aucune décision')

appliquerTrade(e, trade('R4', 'buy', 800, 52_000, 3), opts(3))
verifier(JSON.stringify(decisions(e, S)) === '["entree"]', 'franchissement de 50 K : entrée')

// Conditions d'évaluabilité : elles ne jugent pas le token, elles vérifient
// qu'on a de quoi le juger. Leur absence a produit en production des alertes
// « 0 % sur 1 trade, 0 auteurs » sur des tokens qu'on ne savait pas lire.
const Sc = { ...S, microMinEchantillon: 20, entreeMaxRatio: 3 }
const evaluable = () => {
  const x = creerEtat({ mint: 'E', creator: 'DEV', createdAt: t0, vuA: t0 })
  for (let k = 0; k < 25; k++) appliquerTrade(x, trade(`A${k}`, 'buy', 2, 60_000, 0), opts())
  return x
}
verifier(peutEvaluerEntree(evaluable(), Sc), 'token complet, mesuré et proche du palier : évaluable')
const incomplet = evaluable(); incomplet.complet = false
verifier(!peutEvaluerEntree(incomplet, Sc), 'token sans création vue : pas évaluable, ses auteurs sont inconnus')
const maigre = creerEtat({ mint: 'F', creator: 'DEV', vuA: t0 })
appliquerTrade(maigre, trade('A', 'buy', 2, 60_000, 0), opts())
verifier(!peutEvaluerEntree(maigre, Sc), 'un seul trade mesuré : pas évaluable, l\'abstention vaudrait feu vert')
const tropHaut = evaluable()
appliquerTrade(tropHaut, trade('B', 'buy', 900, 93_300_000, 1), opts(1))
verifier(!peutEvaluerEntree(tropHaut, Sc), '93 M pour un palier à 50 K : le mouvement a eu lieu, pas d\'entrée')
verifier(peutEvaluerEntree(evaluable(), { ...Sc, entreeMaxRatio: null }),
  'plafond de ratio absent : la condition ne s\'applique pas')
e.entreeEvaluee = true
verifier(decisions(e, S).length === 0, 'l\'entrée n\'est évaluée qu\'une fois')

// Les 10 premiers acheteurs sont DEV et W1…W9. DEV est déjà le créateur, et W2
// est un sniper récurrent : restent DEV + W1, W3…W9, soit 9 auteurs.
const sn = new Snipers({ seuil: 3 })
for (let k = 0; k < 3; k++) sn.noter('W2', t0 - k * 1000)
const liste = auteurs(e, { nbPremiers: 10, estSniper: w => sn.est(w, t0) })
verifier(liste[0] === 'DEV' && !liste.includes('W2') && liste.includes('W9') && !liste.includes('W10') && liste.length === 9,
  'auteurs : créateur + 10 premiers acheteurs, sniper récurrent exclu')
verifier(!new Snipers({ seuil: 3 }).est('W2', t0), 'un wallet vu une fois n\'est pas un sniper')

figerAuteurs(e, liste)
e.alertes.entree = { decision: 'alerted', mc: 52_000, at: t0 + 3 * 60_000 }

appliquerTrade(e, trade('Z', 'buy', 20, 120_000, 5), opts(5))
verifier(decisions(e, S).length === 0, `×${multipleAtteint(e).toFixed(1)} : aucun palier`)

appliquerTrade(e, trade('X', 'buy', 100, 400_000, 10), opts(10))
verifier(JSON.stringify(decisions(e, S)) === '["x3"]', `×${multipleAtteint(e).toFixed(1)} : palier ×3`)
marquer(e)
verifier(decisions(e, S).length === 0, 'un palier franchi ne se signale qu\'une fois')

appliquerTrade(e, trade('W1', 'sell', 5, 380_000, 11), opts(11))
verifier(decisions(e, S).length === 0, 'un seul auteur vend : pas encore d\'alerte')
appliquerTrade(e, trade('R9', 'sell', 5, 370_000, 11), opts(11))
verifier(e.ventesAuteurs.size === 1, 'la vente d\'un non-auteur n\'est pas comptée')
appliquerTrade(e, trade('W3', 'sell', 5, 360_000, 12), opts(12))
verifier(JSON.stringify(decisions(e, S)) === '["auteurs"]', 'deux auteurs vendent : alerte de sortie')
e.alertes.auteurs = { at: t0 }

appliquerTrade(e, trade('Y', 'buy', 100, 530_000, 13), opts(13))
verifier(JSON.stringify(decisions(e, S)) === '["x10"]', `×${multipleAtteint(e).toFixed(1)} : palier ×10`)
marquer(e)
verifier(decisions(e, S).length === 0, 'chaque palier n\'est signalé qu\'une fois')

// À t0+13 min, les 5 dernières minutes contiennent X, W1, R9, W3 et Y.
const w = fenetres(e, t0 + 13 * 60_000)
verifier(w['5min'].trades === 5 && w['5min'].sells === 3 && w['5min'].buyers === 2 && w['1h'].trades === e.n,
  `fenêtres glissantes (5 min : ${w['5min'].trades} trades dont ${w['5min'].sells} ventes, 1 h : ${w['1h'].trades})`)

appliquerTrade(e, trade('K', 'buy', 500, 2_000_000, 14), opts(14))
verifier(JSON.stringify(decisions(e, S)) === '["x30"]', `×${multipleAtteint(e).toFixed(0)} : palier ×30`)

// Un token qui saute directement très haut ne produit qu'UNE alerte, la plus haute.
const saut = creerEtat({ mint: 'S', creator: 'D4', vuA: t0 })
saut.entreeEvaluee = true
saut.alertes.entree = { decision: 'alerted', mc: 50_000, at: t0 }
appliquerTrade(saut, trade('A', 'buy', 900, 2_000_000), opts())
verifier(JSON.stringify(decisions(saut, S)) === '["x30"]', 'saut de ×1 à ×40 : une seule alerte, la plus haute')
for (const m of paliersDus(saut, S.multiples)) saut.alertes.multiples.push({ multiple: m, at: t0, mc: saut.mc })
verifier(saut.alertes.multiples.length === 3 && decisions(saut, S).length === 0,
  'les paliers intermédiaires sont marqués, jamais annoncés en retard')

const rejete = creerEtat({ mint: 'R', creator: 'D2', vuA: t0 })
rejete.entreeEvaluee = true
rejete.alertes.entree = { decision: 'rejected', mc: 50_000, at: t0 }
appliquerTrade(rejete, trade('Z', 'buy', 100, 600_000), opts())
verifier(decisions(rejete, S).length === 0, 'entrée rejetée : aucune sortie suivie')

const partiel = creerEtat({ mint: 'P', creator: 'D3', complet: false, vuA: t0 })
partiel.entreeEvaluee = true
partiel.alertes.entree = { decision: 'alerted', mc: 50_000, at: t0 }
figerAuteurs(partiel, ['D3', 'A', 'B'])
appliquerTrade(partiel, trade('A', 'sell', 5, 60_000), opts())
appliquerTrade(partiel, trade('B', 'sell', 5, 60_000), opts())
verifier(!decisions(partiel, S).includes('auteurs'), 'token sans premiers acheteurs connus : pas d\'alerte d\'auteurs')

const vieux = creerEtat({ mint: 'V', vuA: t0 })
appliquerTrade(vieux, trade('A', 'buy', 1, 1000, 0), opts(0))
appliquerTrade(vieux, trade('B', 'buy', 1, 1000, 90), opts(90))
verifier(vieux.recents.length === 1, 'la fenêtre d\'une heure oublie les trades anciens')

const sansCours = creerEtat({ mint: 'C', vuA: t0 })
appliquerTrade(sansCours, { ts: t0, wallet: 'A', cote: 'buy', tokens: 10, usd: null, prixUsd: null, mcUsd: null }, opts())
verifier(partMicro(sansCours) === null && sansCours.mc === null && decisions(sansCours, S).length === 0,
  'trade sans cours : ni part de micro-trades, ni capitalisation, ni décision')

// --- 3. acheteurs réels, liquidité, part des auteurs ------------------------------------

console.log('\n3. Acheteurs réels, liquidité, part des auteurs')
const rb = creerEtat({ mint: 'B2', vuA: t0 })
appliquerTrade(rb, { ts: t0, wallet: 'M1', cote: 'buy', tokens: 10, usd: 0.4, prixUsd: 1e-9, mcUsd: 1000, liquiditeUsd: 25_000 }, opts())
appliquerTrade(rb, { ts: t0, wallet: 'R1', cote: 'buy', tokens: 10, usd: 5, prixUsd: 1e-9, mcUsd: 1000 }, opts())
appliquerTrade(rb, { ts: t0, wallet: 'R1', cote: 'buy', tokens: 10, usd: 7, prixUsd: 1e-9, mcUsd: 1000 }, opts())
verifier(rb.acheteursReels === 1, 'un wallet qui répète ses achats ne compte que pour un acheteur réel')
verifier(fenetres(rb, t0, { microUsd: 1 })['5min'].buyersReels === 1 && fenetres(rb, t0)['5min'].buyers === 2,
  'la fenêtre distingue les acheteurs réels des acheteurs de micro-trades')
verifier(rb.liquiditeUsd === 25_000, 'liquidité retenue depuis les réserves')
appliquerTrade(rb, { ts: t0, wallet: 'R2', cote: 'buy', tokens: 10, usd: 3, prixUsd: 1e-9, mcUsd: 1000, liquiditeUsd: null }, opts())
verifier(rb.liquiditeUsd === 25_000, 'un trade sans réserve connue n\'efface pas la dernière liquidité mesurée')

const av = creerEtat({ mint: 'A2', creator: 'DEV', vuA: t0 })
av.supply = 1_000_000
appliquerTrade(av, { ts: t0, wallet: 'DEV', cote: 'buy', tokens: 200_000, usd: 500, prixUsd: 1e-9, mcUsd: 60_000 }, opts())
appliquerTrade(av, { ts: t0, wallet: 'B', cote: 'buy', tokens: 100_000, usd: 300, prixUsd: 1e-9, mcUsd: 60_000 }, opts())
figerAuteurs(av, ['DEV', 'B'])
verifier(av.partAuteurs === 0.3, `part détenue par les auteurs à l'entrée (${av.partAuteurs})`)
appliquerTrade(av, { ts: t0, wallet: 'DEV', cote: 'sell', tokens: 150_000, usd: 400, prixUsd: 1e-9, mcUsd: 55_000 }, opts())
verifier(av.partAuteurs === 0.15 && av.ventesAuteurs.size === 1,
  `la part suit les ventes des auteurs (${av.partAuteurs})`)
verifier(partDetenue(partiel, ['D3']) === null,
  'token repris en cours de route : part des auteurs inconnue plutôt que fausse')

// --- 4. filtres de l'étage stream --------------------------------------------------------

console.log('\n4. Filtres de l\'étage stream')
const f = (part, n, min = 20, seuil = 0.7) => microTrades.evaluate({ live: { micro_share: part, micro_sample: n, min_sample: min } }, seuil)
verifier(f(0.8, 100).passed && !f(0.8, 100).skipped, '80 % de micro-trades : passe')
verifier(f(0.5, 100).passed === false, '50 % : rejeté')
verifier(f(0.9, 5).skipped && f(0.9, 5).passed, 'échantillon trop petit : abstention, sans rejet')
verifier(f(null, 0).skipped, 'montants inconnus : abstention')
const defaut = microTrades.evaluate({ live: { micro_share: 0.75, micro_sample: 50, min_sample: 20 } }, undefined)
verifier(defaut.passed && defaut.threshold === 0.7,
  `seuil absent de la configuration : valeur par défaut appliquée ET enregistrée (${defaut.threshold})`)

const rbf = (n, seuil) => realBuyers.evaluate({ live: { real_buyers_5m: n, micro_usd: 1 } }, seuil)
verifier(rbf(5, 3).passed && rbf(5, 3).value === 5, '5 acheteurs réels pour un seuil de 3 : passe')
verifier(rbf(1, 3).passed === false, '1 acheteur réel pour un seuil de 3 : rejeté')
verifier(rbf(0, 0).passed, 'seuil à 0 : mesure sans bloquer')
verifier(rbf(null, 3).skipped, 'acheteurs réels inconnus : abstention')

// --- 5. mesure seule et exclusion ---------------------------------------------------------

console.log('\n5. Mesure seule et exclusion')
const cfgT = {
  thresholds: {
    filters: { sell_pressure: 1.2, wash_index: 8, top_holders: 30, lp_secured: 95 },
    alert: { min_score: 70, max_mc: 2_000_000 },
    stream: { micro_share: 0.7, min_real_buyers_5m: 3 }
  }
}
const ctxT = {
  _id: 'solana:test',
  mc: 60_000, threshold_franchi: 50_000,
  velocity: { buySellRatio: 0.5, washIndex: 20, acceleration: { direction: 'down', ratio: 0.4, confident: true } },
  holders: { top10Pct: 55 },
  bonding: { bonded: true },
  liquidity: { liquidityUsd: 30_000, liquidityBurnPct: null },
  live: { micro_share: 0.9, micro_sample: 50, min_sample: 20, real_buyers_5m: 1, micro_usd: 1 }
}

const dur = await runFilters('deep', ctxT, cfgT)
verifier(dur.passed === false && ['flat_velocity', 'wash_trading', 'sell_pressure', 'top_holders'].includes(dur.rejectionReason),
  `sans mesure seule, le premier filtre bloquant rejette (${dur.rejectionReason})`)

const tousDeep = (await filtersFor('deep')).map(x => x.name)
const doux = await runFilters('deep', ctxT, cfgT, { mesureSeule: tousDeep })
verifier(doux.passed === true && doux.rejectionReason === null,
  'en mesure seule, aucun filtre profond ne rejette')
verifier(doux.results.length === tousDeep.length && doux.results.every(r => r.enforced === false),
  `les ${doux.results.length} filtres profonds sont quand même évalués et marqués non appliqués`)
const sp = doux.results.find(r => r.name === 'sell_pressure')
verifier(sp?.value === 0.5 && sp?.passed === false,
  'la valeur mesurée et son échec restent enregistrés, pour que M5 puisse balayer le seuil')

const stream = await runFilters('stream', ctxT, cfgT, { mesureSeule: ['real_buyers'] })
verifier(stream.passed === true && stream.results.find(r => r.name === 'real_buyers')?.passed === false,
  'un filtre en mesure seule échoue sans bloquer l\'entrée')
verifier(stream.results.find(r => r.name === 'micro_trades')?.passed === true,
  'le filtre de fabrication, lui, reste appliqué')

const sans = (await filtersFor('deep', { exclude: ['wash_trading', 'flat_velocity'] })).map(x => x.name)
verifier(!sans.includes('wash_trading') && sans.length === tousDeep.length - 2,
  'un filtre exclu n\'est pas évalué du tout, contrairement à la mesure seule')

const r = reglages({ thresholds: { stream: { entry_mc: 60_000, exit_multiples: [30, 3, 10] } } })
verifier(r.entreeMc === 60_000 && JSON.stringify(r.multiples) === '[3,10,30]' && r.microUsd === 1,
  'réglages : la configuration prime, les défauts complètent, les paliers sont triés')
verifier(reglages({}).mesureSeule.includes('top_holders') && reglages({}).exclus.length === 0,
  'par défaut : tout est mesuré, rien n\'est exclu')
verifier(reglages({}).endpoints.length >= 2 && reglages({}).multiples.length >= 2,
  'deux points d\'accès et des paliers échelonnés par défaut')

console.log(`\n${ok} vérifications passées, ${ko} en échec`)
process.exit(ko ? 1 : 0)
