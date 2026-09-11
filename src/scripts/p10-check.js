/**
 * P10 — flux temps réel pump.fun : décodage, état, décisions.
 *
 * Aucun réseau. Le décodage est vérifié sur de VRAIS journaux capturés sur le
 * mainnet (fixtures/pump-logs.json) ; l'état et les décisions sur des
 * séquences de trades construites à la main, où l'on sait ce qui doit sortir.
 *
 * Usage : npm run p10
 */

import { readFileSync } from 'node:fs'
import { decoderEvenement, normaliser, evenementsDesLogs } from '../collector/pump/decode.js'
import { creerEtat, appliquerTrade, partMicro, fenetres, auteurs, figerAuteurs, decisions, Snipers }
  from '../collector/pump/state.js'
import microTrades from '../pipeline/filters/stream/micro_trades.js'
import { filtersFor } from '../pipeline/filters/index.js'
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
verifier(evenementsDesLogs(['Program log: Instruction: Buy', 'Program data: !!!', 'Program data: AAAA']).length === 0,
  'lignes illisibles ignorées sans exception')

// --- 2. état et décisions ------------------------------------------------------------

console.log('\n2. État et décisions')
const S = { entreeMc: 50_000, multipleSortie: 10, auteursMin: 2 }
const t0 = Date.parse('2026-09-11T12:00:00Z')
const opts = (min = 0) => ({ maxPremiers: 20, microUsd: 1, now: t0 + min * 60_000 })
const trade = (wallet, cote, usd, mc, min = 0) => ({ ts: t0 + min * 60_000, wallet, cote, tokens: 1000, usd, prixUsd: mc / 1e9, mcUsd: mc, venue: 'courbe' })

const e = creerEtat({ mint: 'M', creator: 'DEV', createdAt: t0, vuA: t0 })
appliquerTrade(e, trade('DEV', 'buy', 50, 3_000), opts())
for (let k = 1; k <= 12; k++) appliquerTrade(e, trade(`W${k}`, 'buy', 0.3, 3_000 + k * 100, k / 10), opts(k / 10))
for (let k = 1; k <= 3; k++) appliquerTrade(e, trade(`R${k}`, 'buy', 40, 6_000 + k * 1000, 2), opts(2))

verifier(e.premiers.length === 16 && e.premiers[0].wallet === 'DEV' && e.premiers[1].wallet === 'W1',
  'premiers acheteurs distincts, dans l\'ordre')
verifier(Math.abs(partMicro(e) - 12 / 16) < 1e-9, `part de micro-trades exacte (${partMicro(e)})`)
verifier(decisions(e, S).length === 0, 'sous 50 K : aucune décision')

appliquerTrade(e, trade('R4', 'buy', 800, 52_000, 3), opts(3))
verifier(JSON.stringify(decisions(e, S)) === '["entree"]', 'franchissement de 50 K : entrée')
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
appliquerTrade(e, trade('X', 'buy', 100, 400_000, 10), opts(10))
verifier(decisions(e, S).length === 0, '×7,7 : pas encore de sortie')
appliquerTrade(e, trade('W1', 'sell', 5, 380_000, 11), opts(11))
verifier(decisions(e, S).length === 0, 'un seul auteur vend : pas encore d\'alerte')
appliquerTrade(e, trade('R9', 'sell', 5, 370_000, 11), opts(11))
verifier(e.ventesAuteurs.size === 1, 'la vente d\'un non-auteur n\'est pas comptée')
appliquerTrade(e, trade('W3', 'sell', 5, 360_000, 12), opts(12))
verifier(JSON.stringify(decisions(e, S)) === '["auteurs"]', 'deux auteurs vendent : alerte de sortie')
e.alertes.auteurs = { at: t0 }
appliquerTrade(e, trade('Y', 'buy', 100, 530_000, 13), opts(13))
verifier(JSON.stringify(decisions(e, S)) === '["x10"]', '×10 depuis l\'entrée : alerte de sortie')
e.alertes.x10 = { at: t0 }
verifier(decisions(e, S).length === 0, 'chaque sortie n\'est signalée qu\'une fois')

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

// À t0+13 min, les 5 dernières minutes contiennent X, W1, R9, W3 et Y.
const w = fenetres(e, t0 + 13 * 60_000)
verifier(w['5min'].trades === 5 && w['5min'].sells === 3 && w['5min'].buyers === 2 && w['1h'].trades === e.n,
  `fenêtres glissantes (5 min : ${w['5min'].trades} trades dont ${w['5min'].sells} ventes, 1 h : ${w['1h'].trades})`)

const vieux = creerEtat({ mint: 'V', vuA: t0 })
appliquerTrade(vieux, trade('A', 'buy', 1, 1000, 0), opts(0))
appliquerTrade(vieux, trade('B', 'buy', 1, 1000, 90), opts(90))
verifier(vieux.recents.length === 1, 'la fenêtre d\'une heure oublie les trades anciens')

const sansCours = creerEtat({ mint: 'C', vuA: t0 })
appliquerTrade(sansCours, { ts: t0, wallet: 'A', cote: 'buy', tokens: 10, usd: null, prixUsd: null, mcUsd: null }, opts())
verifier(partMicro(sansCours) === null && sansCours.mc === null && decisions(sansCours, S).length === 0,
  'trade sans cours : ni part de micro-trades, ni capitalisation, ni décision')

// --- 3. filtre micro_trades ------------------------------------------------------------

console.log('\n3. Filtre micro_trades')
const f = (part, n, min = 20, seuil = 0.7) => microTrades.evaluate({ live: { micro_share: part, micro_sample: n, min_sample: min } }, seuil)
verifier(f(0.8, 100).passed && !f(0.8, 100).skipped, '80 % de micro-trades : passe')
verifier(f(0.5, 100).passed === false, '50 % : rejeté')
verifier(f(0.9, 5).skipped && f(0.9, 5).passed, 'échantillon trop petit : abstention, sans rejet')
verifier(f(null, 0).skipped, 'montants inconnus : abstention')
verifier(microTrades.evaluate({ live: { micro_share: 0.75, micro_sample: 50, min_sample: 20 } }, undefined).passed,
  'seuil absent de la configuration : valeur par défaut (0,7)')

// --- 4. exclusion de filtres et réglages ------------------------------------------------

console.log('\n4. Exclusion de filtres et réglages')
const tous = (await filtersFor('deep')).map(x => x.name)
const sans = (await filtersFor('deep', { exclude: ['wash_trading', 'flat_velocity'] })).map(x => x.name)
verifier(tous.includes('wash_trading') && !sans.includes('wash_trading') && !sans.includes('flat_velocity'),
  'exclusion ciblée des filtres qui lisent les traders')
verifier(sans.length === tous.length - 2, 'les autres filtres profonds restent actifs')
verifier((await filtersFor('stream')).some(x => x.name === 'micro_trades'), 'étage stream chargé')

const r = reglages({ thresholds: { stream: { entry_mc: 60_000 } } })
verifier(r.entreeMc === 60_000 && r.multipleSortie === 10 && r.microUsd === 1,
  'réglages : la configuration prime, les défauts complètent')
verifier(reglages({}).endpoints.length >= 2, 'deux points d\'accès par défaut')

console.log(`\n${ok} vérifications passées, ${ko} en échec`)
process.exit(ko ? 1 : 0)
