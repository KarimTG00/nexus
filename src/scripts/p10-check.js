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
  decisions, peutEvaluerEntree, paliersDus, multipleAtteint, Snipers,
  marquerGraduation, croisementsDus, signauxCroisement, majBougie, fermerBougie, evaluerRecyclage } from '../collector/pump/state.js'
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

// Traversée DESCENDANTE : monté au-dessus de la bande, puis retombé dedans.
// C'est le cas BEAST observé en production — alerte à 115 K en pleine chute.
const chute = evaluable()
appliquerTrade(chute, trade('Z1', 'buy', 900, 4_600_000, 1), opts(1))
appliquerTrade(chute, trade('Z2', 'sell', 900, 115_000, 2), opts(2))
verifier(chute.mc === 115_000 && !peutEvaluerEntree(chute, Sc),
  'monté à 4,6 M puis retombé à 115 K : c\'est une chute, pas une entrée')
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
verifier(w['5min'].mcDebut === 400_000 && Math.abs(w['5min'].variation - (530_000 / 400_000 - 1)) < 1e-9,
  `sens du mouvement sur 5 min : de 400 K à 530 K, soit +${Math.round(w['5min'].variation * 100)} %`)

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
verifier(reglages({}).envoyerSorties === false,
  'alertes de sortie enregistrées mais non envoyées par défaut')

// --- 6. montées organiques et usine ---------------------------------------------------------

console.log('\n6. Montées organiques et usine')
const So = { entreeMc: 20_000, entreeMaxRatio: 3, microMinEchantillon: 0, multiples: [3], auteursMin: 2,
  mesureMc: [10_000, 15_000, 20_000], organiqueSeul: true, ageOrganiqueMs: 2000 }
const tc = (wallet, cote, usd, mc, s, tokens = 1000, venue = 'courbe') =>
  ({ ts: t0 + s * 1000, wallet, cote, tokens, usd, prixUsd: mc / 1e9, mcUsd: mc, venue })
const oc = s => ({ maxPremiers: 20, microUsd: 1, now: t0 + s * 1000 })

// Usine : tout se passe dans la seconde de la création.
const us = creerEtat({ mint: 'U', creator: 'FAB', createdAt: t0, vuA: t0 })
appliquerTrade(us, tc('FAB', 'buy', 500, 25_000, 0.3), oc(0.3))
const jugesUsine = croisementsDus(us, So)
verifier(jugesUsine.length === 3 && jugesUsine.every(c => !c.retenu && c.raison === 'trop_jeune'),
  'seuils franchis dans la seconde de création : écartés, jamais retenus')
for (const c of jugesUsine) us.croisements.add(c.seuil)
verifier(!peutEvaluerEntree(us, So), 'token dans sa première seconde : pas d\'entrée')
verifier(marquerGraduation(us, t0 + 800) && us.usine === true && us.graduation.mcCourbe === 25_000,
  'graduation 0,8 s après la création : usine')
verifier(!marquerGraduation(us, t0 + 5000) && us.gradueA === t0 + 800, 'la graduation n\'est notée qu\'une fois')
appliquerTrade(us, tc('PUMP', 'buy', 90_000, 3_000_000, 0.9, 1000, 'amm'), oc(0.9))
verifier(us.graduation.mcAmm === 3_000_000 && us.mcMaxA === t0 + 900,
  'saut mesuré au premier trade PumpSwap, instant du sommet noté')
appliquerTrade(us, tc('PUMP', 'sell', 90_000, 1_400_000, 40, 1000, 'amm'), oc(40))
verifier(us.premiereMoitie?.ts === t0 + 40_000 && us.premiereMoitie.sommet === 3_000_000 && us.premiereMoitie.sommetA === t0 + 900,
  'première retombée sous la moitié du sommet : instant et sommet notés')
verifier(croisementsDus(us, So).length === 0, 'seuils déjà jugés : jamais rejugés, même au-dessus')

const lent = creerEtat({ mint: 'G', createdAt: t0, vuA: t0 })
marquerGraduation(lent, t0 + 300_000)
const inconnu = creerEtat({ mint: 'I', complet: false, vuA: t0 })
marquerGraduation(inconnu, t0)
verifier(lent.usine === false && inconnu.usine === null,
  'graduation après 5 min : organique ; création non vue : délai inconnu, pas de verdict')

// Organique : se construit sur la courbe pendant une minute.
const og = creerEtat({ mint: 'O', creator: 'DEV', createdAt: t0, vuA: t0 })
og.supply = 1_000_000
appliquerTrade(og, tc('DEV', 'buy', 50, 3_000, 0, 50_000), oc(0))
appliquerTrade(og, tc('BUN', 'buy', 30, 4_000, 0.5, 40_000), oc(0.5))
for (let k = 1; k <= 8; k++) appliquerTrade(og, tc(`H${k}`, 'buy', 20, 4_000 + k * 700, 30 + k, 10_000), oc(30 + k))
appliquerTrade(og, tc('DEV', 'sell', 10, 9_000, 45, 20_000), oc(45))
appliquerTrade(og, tc('BIG', 'buy', 200, 16_000, 60, 100_000), oc(60))
verifier(JSON.stringify(croisementsDus(og, So).map(c => [c.seuil, c.retenu])) === '[[10000,true],[15000,true]]',
  'montée organique à 16 K après une minute : 10 K et 15 K retenus')

const sg = signauxCroisement(og, { now: t0 + 60_000, nbAuteurs: 10 })
verifier(sg.age_s === 60 && sg.part_dev === 0.03 && sg.dev_a_vendu === true,
  `signaux : âge ${sg.age_s} s, part du créateur ${sg.part_dev} après sa vente`)
verifier(sg.acheteurs_bloc0 === 1 && sg.part_bloc0 === 0.04,
  'acheteurs de la première seconde comptés hors créateur, avec leur part')
verifier(sg.part_top10 === 0.24 && sg.detenteurs === 11 && sg.premiers_vendeurs === 1,
  `concentration : top 10 ${sg.part_top10}, ${sg.detenteurs} détenteurs, ${sg.premiers_vendeurs} premier acheteur vendeur`)

appliquerTrade(og, tc('R', 'buy', 50, 21_000, 70), oc(70))
verifier(peutEvaluerEntree(og, So), 'montée organique franchissant 20 K : entrée évaluable')
verifier(!peutEvaluerEntree({ ...og, gradue: true }, So), 'token déjà gradué : plus organique, pas d\'entrée')

const dp = creerEtat({ mint: 'D', createdAt: t0, vuA: t0 })
appliquerTrade(dp, tc('A', 'buy', 100, 40_000, 10), oc(10))
verifier(JSON.stringify(croisementsDus(dp, So).map(c => c.raison)) === '["deja_passe",null,null]',
  'vu d\'un coup à 40 K : 10 K déjà dépassé de plus de 3×, 15 K et 20 K retenus')

const rg = reglages({})
verifier(rg.entreeMc === 20_000 && rg.organiqueSeul === true && rg.ageOrganiqueMs === 2000 && rg.usineMaxMs === 2000
  && JSON.stringify(rg.mesureMc) === '[10000,15000,20000,30000]',
  'par défaut : entrée organique à 20 K, seuils mesurés 10 K à 30 K')

// --- 7. bougies ---------------------------------------------------------------------------------

console.log('\n7. Bougies')
const bg = creerEtat({ mint: 'K', vuA: t0 })
const tb = (s, mc, cote = 'buy', usd = 10, wallet = 'A') => ({ ts: t0 + s * 1000, mcUsd: mc, usd, cote, wallet, venue: 'courbe' })
majBougie(bg, tb(1, 10_000))
majBougie(bg, tb(20, 14_000, 'buy', 5, 'B'))
majBougie(bg, tb(40, 9_000, 'sell', 3))
majBougie(bg, tb(59, 12_000, 'buy', 2, 'B'))
const m1 = bg.series.m1
verifier(m1.ouverte.o === 10_000 && m1.ouverte.h === 14_000 && m1.ouverte.l === 9_000 && m1.ouverte.c === 12_000
  && m1.fermees.length === 0, 'une minute : ouverture, plus haut, plus bas, clôture')
majBougie(bg, tb(61, 13_000))
const b1 = m1.fermees[0]
verifier(m1.fermees.length === 1 && b1.debut === t0 && b1.volumeUsd === 20 && b1.achats === 3 && b1.ventes === 1 && b1.acheteurs === 2,
  'minute suivante : la précédente est fermée avec son volume, ses achats, ventes et acheteurs distincts')
verifier(!majBougie(bg, tb(30, 50_000)) && m1.ouverte.h === 13_000, 'trade en retard sur une bougie fermée : ignoré')
verifier(!majBougie(bg, tb(62, null)), 'trade sans capitalisation : aucune bougie')
fermerBougie(bg)
verifier(m1.ouverte === null && m1.fermees.length === 2 && m1.fermees[1].o === 13_000,
  'fermeture forcée : la bougie ouverte rejoint celles à écrire')

// Même minute, deux séries : la bougie de 10 s dit dans quel ordre sont venus
// le sommet et le creux, ce que la bougie d'une minute confond.
const fin = creerEtat({ mint: 'F10', vuA: t0 })
for (const [s, mc] of [[2, 10_000], [8, 20_500], [14, 6_000], [55, 9_000]]) {
  majBougie(fin, tb(s, mc), { dureeMs: 60_000, serie: 'm1' })
  majBougie(fin, tb(s, mc), { dureeMs: 10_000, serie: 's10' })
}
fermerBougie(fin, 's10')
const s10 = fin.series.s10.fermees
verifier(fin.series.m1.ouverte.h === 20_500 && fin.series.m1.ouverte.l === 6_000 && s10.length === 3
  && s10[0].h === 20_500 && s10[1].l === 6_000 && s10[1].debut === t0 + 10_000,
  'série de 10 s : ×2 à la 8e seconde, creux à la 14e — l\'ordre est lisible, la minute le confondait')

const rb2 = reglages({})
verifier(rb2.bougiesMc === 10_000 && rb2.bougiesMs === 4 * 3_600_000 && rb2.bougieDureeMs === 60_000
  && rb2.bougiesFinesMs === 30 * 60_000 && rb2.bougieFineDureeMs === 10_000
  && rb2.mesureSeule.includes('micro_trades'),
  'par défaut : bougies d\'une minute pendant 4 h et de 10 s pendant 30 min dès 10 K, micro_trades en mesure seule')

// --- 8. wallets alpha -----------------------------------------------------------------------

console.log('\n8. Wallets alpha')
const { resumerTransaction } = await import('../collector/pump/alpha.js')
const WA = 'A1phaWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const WN = 'NewWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const txA = {
  meta: {
    err: null, fee: 5000,
    preBalances: [5e9, 0, 1], postBalances: [3.99e9, 1e9, 1],
    innerInstructions: [{ instructions: [
      { program: 'system', parsed: { type: 'transfer', info: { source: WA, destination: 'TIPTIP', lamports: 1e7 } } }
    ] }],
    preTokenBalances: [{ owner: WA, mint: 'MINT1', uiTokenAmount: { uiAmount: 1000 } }],
    postTokenBalances: []
  },
  transaction: { message: {
    accountKeys: [{ pubkey: WA }, { pubkey: WN }, { pubkey: '11111111111111111111111111111111' }],
    instructions: [{ program: 'system', programId: '11111111111111111111111111111111',
      parsed: { type: 'transfer', info: { source: WA, destination: WN, lamports: 1e9 } } }]
  } }
}
const ra = resumerTransaction(txA, WA)
verifier(ra.sol_delta === -1.01 && ra.sol_apres === 3.99 && ra.frais_sol === 0.000005,
  `variation de SOL du wallet lue sur ses soldes (${ra.sol_delta} SOL)`)
verifier(ra.virements.length === 2 && ra.virements[0].vers === WN && ra.virements[0].sol === 1 && ra.virements[1].sol === 0.01,
  'virements système, instructions internes comprises : le wallet armé et le pourboire')
verifier(ra.tokens.length === 1 && ra.tokens[0].mint === 'MINT1' && ra.tokens[0].delta === -1000,
  'compte de token fermé dans la transaction : tout le solde est sorti')
verifier(ra.programmes.length === 1 && resumerTransaction({ meta: null }, WA) === null,
  'programmes appelés relevés ; transaction illisible : aucun résumé inventé')

// --- 9. lancements recyclés ---------------------------------------------------------------------

console.log('\n9. Lancements recyclés')
const rc = creerEtat({ mint: 'RC2', creator: 'DEVR', createdAt: t0, vuA: t0 })
for (const [k, w] of ['DEVR', 'G1', 'G2', 'X1', 'X2', 'X3', 'X4'].entries()) {
  appliquerTrade(rc, tc(w, 'buy', 5, 3000 + k * 100, k * 0.2), oc(k * 0.2))
}
const ev = evaluerRecyclage(rc, [{ mint: 'RC1', premiers: new Set(['G1', 'G2', 'Z']) }], { nbPremiers: 6, minRecurrents: 2 })
verifier(ev.recycle && ev.recurrents.join() === 'G1,G2' && ev.premiers.length === 6 && !ev.premiers.includes('DEVR') && ev.precedents === 1,
  'nom déjà lancé, 2 premiers acheteurs déjà présents : lancement recyclé, créateur exclu')
verifier(!evaluerRecyclage(rc, [{ mint: 'RC1', premiers: new Set(['G1']) }]).recycle,
  'un seul acheteur en commun : pas une équipe')
verifier(!evaluerRecyclage(rc, [{ mint: 'RC2', premiers: new Set(['G1', 'G2']) }]).recycle,
  'le lancement lui-même ne compte pas comme précédent')
verifier(!evaluerRecyclage(rc, []).recycle, 'nom jamais lancé : pas recyclé')
verifier(!evaluerRecyclage(rc, [{ mint: 'RC1', premiers: new Set(['G1', 'G2']) }], { estOmnipresent: w => w === 'G2' }).recycle,
  'un sniper omniprésent ne compte pas comme membre d\'équipe')
const rr = reglages({})
verifier(rr.recyclePremiers === 6 && rr.recycleMin === 2 && rr.recycleFenetreMs === 7 * 86_400_000 && rr.recycleAgeMs === 30_000
  && rr.recycleMaxNoms === 30,
  'par défaut : 6 premiers acheteurs, 2 récurrents, fenêtre de 7 jours, jugé au plus tard à 30 s')

console.log(`\n${ok} vérifications passées, ${ko} en échec`)
process.exit(ko ? 1 : 0)
