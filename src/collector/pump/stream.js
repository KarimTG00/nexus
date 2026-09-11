/**
 * Flux temps réel pump.fun — chaque trade, à la seconde.
 *
 * Remplace, pour pump.fun, la salle d'attente du pipeline Mobula. Mesuré sur
 * 257 tokens montés au-dessus de 1 M : on les découvrait 4 min après leur
 * création, puis on attendait 42 min avant de les admettre — et c'est pendant
 * cette attente qu'ils montaient. Le déclencheur ne regardait que les tokens
 * déjà admis : aucun palier ne pouvait les rattraper.
 *
 * Ici un token est suivi dès sa création (`CreateEvent`), et chaque trade met
 * à jour sa capitalisation, sa part de micro-trades et ses auteurs. Le
 * franchissement de 50 K est vu au trade qui le provoque.
 *
 * TRANSPORT — deux WebSockets gratuits, écoutés en même temps :
 *   Alchemy   n'implémente aucun abonnement Solana (vérifié, -32601)
 *   Ankr      WebSocket réservé au plan payant, 500 crédits par notification
 *   Mobula    flux réservés au plan Growth (« Your current plan is 'free' »)
 *   QuickNode facturé au volume : 44 M crédits/mois pour la seule courbe,
 *             4,4 fois son plan gratuit — branché s'il est configuré
 *   public    RPC Solana et PublicNode : mesurés identiques (676 signatures
 *             communes sur 702 en 20 s), dédupliqués par signature
 *
 * Coût en crédits : nul. Le seul appel payant reste l'analyse Mobula au
 * franchissement de 50 K, comme dans le déclencheur existant.
 */

import { mod } from '../../core/logger.js'
import { CONFIG_V1 } from '../../core/config/defaults.js'
import { fournisseur } from '../../adapters/rpc/providers.js'
import { PUMP, PUMPSWAP, WSOL, evenementsDesLogs, normaliser, decoderPool } from './decode.js'
import { creerEtat, appliquerTrade, decisions, Snipers } from './state.js'
import { evaluerEntree, alerterSortie } from './alertes.js'
import * as live from '../../repos/live.js'

const log = mod('collector:pump')

const D = CONFIG_V1.thresholds.stream

/** Réglages effectifs : la configuration active, complétée par les valeurs par défaut. */
export function reglages(cfg) {
  const s = { ...D, ...(cfg?.thresholds?.stream ?? {}) }
  return {
    endpoints: s.endpoints,
    entreeMc: s.entry_mc,
    multipleSortie: s.exit_multiple,
    auteursMin: s.exit_authors_min,
    nbAuteurs: s.authors_first_buyers,
    microUsd: s.micro_trade_usd,
    microMinEchantillon: s.micro_min_sample,
    exclus: s.excluded_filters,
    persistMc: s.persist_mc,
    etudeMc: s.study_mc,
    temoinPourMille: s.control_permille,
    inactifMin: s.idle_minutes,
    suiviHeures: s.follow_hours,
    snipersSeuil: s.sniper_min_tokens,
    ecritureMs: s.flush_seconds * 1000,
    tamponMax: s.buffer_max_trades
  }
}

/** Le flux tourne-t-il ? `STREAM=off` le coupe sur un poste de développement. */
export function fluxActif(cfg) {
  return (cfg?.features?.stream?.enabled ?? CONFIG_V1.features.stream.enabled) && process.env.STREAM !== 'off'
}

// --- état du module -----------------------------------------------------------

const etats = new Map()        // mint → état (state.js)
const pools = new Map()        // pool PumpSwap → { mint, quoteMint, baseDec, quoteDec }
const createurs = new Map()    // créateur → nombre de tokens suivis
const vues = new Map()         // signature → instant de réception
const aResoudre = new Set()    // pools à relier à leur mint
const poolsIllisibles = new Set()
const aEcrire = []             // trades de l'étude, en attente d'écriture
const connexions = []
const minuteurs = []

let snipers = new Snipers()
let cfgCourante = null
let S = null
let solUsd = null
let solUsdA = 0
let ecritureEnCours = false
let resolutionEnCours = false

const stats = {
  messages: 0, doublons: 0, echecs: 0, evenements: 0, trades: 0, creations: 0,
  graduations: 0, sansCours: 0, poolsResolus: 0, poolsEnEchec: 0,
  entrees: 0, sorties: 0, tradesEcrits: 0, persistes: 0, archives: 0
}

// --- connexions ------------------------------------------------------------------

const SILENCE_MS = 60_000

class Connexion {
  constructor(url) {
    this.url = url
    this.nom = new URL(url).hostname      // jamais l'URL entière : elle peut porter une clé
    this.ws = null
    this.attente = 2000
    this.arrete = false
    this.relanceEnCours = false
    this.dernier = 0
    this.stats = { messages: 0, reconnexions: 0, erreurs: 0 }
  }

  ouvrir() {
    if (this.arrete) return
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.attente = 2000
      this.dernier = Date.now()
      ;[PUMP, PUMPSWAP].forEach((p, i) => ws.send(JSON.stringify({
        jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe',
        params: [{ mentions: [p] }, { commitment: 'confirmed' }]
      })))
      log.info({ source: this.nom }, 'flux pump.fun ouvert')
    })

    ws.addEventListener('message', ev => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.error) {
        this.stats.erreurs++
        log.warn({ source: this.nom, err: m.error.message }, 'abonnement refusé')
        return
      }
      const v = m.params?.result?.value
      if (!v) return
      this.dernier = Date.now()
      this.stats.messages++
      recevoir(v)
    })

    ws.addEventListener('close', () => this.relancer('connexion fermée'))
    ws.addEventListener('error', () => { this.stats.erreurs++ })
  }

  /**
   * Reprise avec recul exponentiel, sans limite de tentatives : un point
   * d'accès gratuit peut tomber puis revenir, et l'autre couvre l'intervalle.
   */
  relancer(raison) {
    if (this.arrete || this.relanceEnCours) return
    this.relanceEnCours = true
    this.stats.reconnexions++
    try { this.ws?.close() } catch { /* déjà fermée */ }
    log.warn({ source: this.nom, raison, dans_ms: this.attente }, 'flux pump.fun interrompu — reprise')
    setTimeout(() => { this.relanceEnCours = false; this.ouvrir() }, this.attente)
    this.attente = Math.min(60_000, this.attente * 2)
  }

  /** Un point d'accès public peut rester connecté sans plus rien envoyer. */
  surveiller(now) {
    if (this.ws && this.dernier && now - this.dernier > SILENCE_MS) this.relancer('silence de 60 s')
  }

  fermer() {
    this.arrete = true
    try { this.ws?.close() } catch { /* déjà fermée */ }
  }
}

// --- traitement ---------------------------------------------------------------------

function recevoir(v) {
  stats.messages++
  // Chaque transaction arrive par chaque connexion : la première fait foi.
  if (vues.has(v.signature)) { stats.doublons++; return }
  vues.set(v.signature, Date.now())
  // Près de la moitié des transactions échouent (mesuré : 361 sur 702) ;
  // leurs journaux décrivent un trade qui n'a pas eu lieu.
  if (v.err) { stats.echecs++; return }

  evenementsDesLogs(v.logs).forEach((evt, i) => {
    stats.evenements++
    try { traiter(evt, v.signature, i) } catch (e) {
      log.warn({ evenement: evt.nom, sig: v.signature, err: e.message }, 'événement non traité')
    }
  })
}

function traiter(evt, sig, i) {
  const n = normaliser(evt, { pools })
  if (!n) return
  const now = Date.now()

  switch (n.type) {
    case 'create': return surCreation(n, now)
    case 'complete': {
      stats.graduations++
      const e = etats.get(n.mint)
      if (e) { e.gradue = true; e.gradueA = n.ts; e.sale = true }
      return
    }
    case 'pool': return surPool(n)
    case 'pool_inconnu':
      // On ne résout que les pools des tokens qu'on suit, reconnus par leur
      // créateur : PumpSwap porte aussi des milliers de pools sans intérêt.
      if (n.coinCreator && createurs.has(n.coinCreator) && !poolsIllisibles.has(n.pool)) aResoudre.add(n.pool)
      return
    case 'trade': return surTrade(n, sig, i, now)
    default: return
  }
}

function noterCreateur(creator, delta) {
  if (!creator) return
  const v = (createurs.get(creator) ?? 0) + delta
  if (v > 0) createurs.set(creator, v); else createurs.delete(creator)
}

/** Échantillon témoin, tiré par hachage du mint : reproductible d'un redémarrage à l'autre. */
function temoin(mint, pourMille) {
  let h = 2166136261
  for (let k = 0; k < mint.length; k++) { h ^= mint.charCodeAt(k); h = Math.imul(h, 16777619) }
  return (h >>> 0) % 1000 < pourMille
}

function surCreation(n, now) {
  if (etats.has(n.mint)) return
  const e = creerEtat({ mint: n.mint, symbol: n.symbol, name: n.name, uri: n.uri, creator: n.creator,
    curve: n.curve, createdAt: n.ts, complet: true, vuA: now })
  e.supply = n.supply ?? null
  e.temoin = temoin(n.mint, S.temoinPourMille)
  etats.set(n.mint, e)
  noterCreateur(n.creator, +1)
  stats.creations++
}

function surPool(n) {
  const info = { mint: n.mint, quoteMint: n.quoteMint, baseDec: n.baseDec, quoteDec: n.quoteDec }
  pools.set(n.pool, info)
  live.enregistrerPool({ pool: n.pool, ...info }).catch(e => log.warn({ err: e.message }, 'pool non enregistré'))
  const e = etats.get(n.mint)
  if (e) { e.pool = n.pool; e.sale = true }
}

function surTrade(n, sig, i, now) {
  let e = etats.get(n.mint)
  if (!e) {
    // Né avant notre écoute : on le suit, mais sans ses premiers acheteurs.
    // Un trade AMM d'un token inconnu n'ouvre rien : PumpSwap porte des
    // milliers d'anciens tokens, et les suivre tous n'aurait aucun sens.
    if (n.venue !== 'courbe') return
    e = creerEtat({ mint: n.mint, creator: n.creator, complet: false, vuA: now })
    e.temoin = false        // l'étude veut des historiques complets
    etats.set(n.mint, e)
    noterCreateur(n.creator, +1)
  }

  const cours = n.quote === 'SOL' ? solUsd : n.quote === 'USDC' ? 1 : null
  if (cours === null) stats.sansCours++
  const usd = cours !== null && n.montant !== null ? n.montant * cours : null
  const prixUsd = cours !== null && n.prix !== null ? n.prix * cours : null
  // L'offre n'est pas toujours d'un milliard : certaines courbes démarrent
  // sur d'autres paramètres. Celle du CreateEvent fait foi quand on l'a vue.
  const offre = n.offre ?? e.supply ?? 1e9
  const mcUsd = prixUsd !== null ? prixUsd * offre : null

  if (n.venue === 'amm') {
    if (!e.gradue) { e.gradue = true; e.gradueA = e.gradueA ?? n.ts }
    if (n.pool && !e.pool) e.pool = n.pool
  }

  const avant = e.premiers.length
  appliquerTrade(e, { ts: n.ts, wallet: n.wallet, cote: n.cote, tokens: n.tokens, usd, prixUsd, mcUsd, venue: n.venue },
    { maxPremiers: Math.max(20, S.nbAuteurs), microUsd: S.microUsd, now })
  if (e.complet && e.premiers.length > avant && e.premiers.length <= S.nbAuteurs) snipers.noter(n.wallet, n.ts)
  e.sale = true
  stats.trades++

  // --- étude : trades complets des tokens qui montent, et d'un témoin ---------
  const doc = {
    _id: `${sig}:${i}`, token: live.idToken(n.mint), ts: new Date(n.ts), wallet: n.wallet,
    side: n.cote, venue: n.venue, tokens: n.tokens, quote_amount: n.montant, quote: n.quote,
    usd, price_usd: prixUsd, mc_usd: mcUsd, rank: e.n
  }
  if (e.etude) {
    aEcrire.push(doc)
  } else {
    e.tampon ??= []
    if (e.tampon.length < S.tamponMax) e.tampon.push(doc)
    if (e.temoin || (mcUsd !== null && mcUsd >= S.etudeMc)) {
      e.etude = true
      aEcrire.push(...e.tampon)
      e.tampon = []
    }
  }

  // --- visibilité : écrit en base dès qu'il montre de la vie -------------------
  if (!e.persiste && mcUsd !== null && mcUsd >= S.persistMc) {
    e.persiste = true
    live.persisterToken(e, { configVersion: cfgCourante._id })
      .then(nouveau => { if (nouveau) stats.persistes++ })
      .catch(err => { e.persiste = false; log.warn({ mint: n.mint, err: err.message }, 'token non écrit') })
  }

  for (const d of decisions(e, S)) agir(d, e, now)
}

function agir(d, e, now) {
  if (d === 'entree') {
    e.entreeEvaluee = true
    stats.entrees++
    evaluerEntree(e, { cfg: cfgCourante, s: S, snipers, now })
      .then(() => { e.sale = true })
      .catch(err => log.error({ mint: e.mint, err: err.message, stack: err.stack }, 'évaluation d\'entrée en échec'))
    return
  }
  if (d === 'x10') e.alertes.x10 = { at: now, mc: e.mc }
  if (d === 'auteurs') e.alertes.auteurs = { at: now, mc: e.mc, vendeurs: e.ventesAuteurs.size }
  e.sale = true
  stats.sorties++
  alerterSortie(e, d, { cfg: cfgCourante, s: S })
    .catch(err => log.error({ mint: e.mint, type: d, err: err.message }, 'alerte de sortie en échec'))
}

// --- tâches périodiques ----------------------------------------------------------

async function ecrire() {
  if (ecritureEnCours) return
  ecritureEnCours = true
  try {
    if (aEcrire.length) {
      const lot = aEcrire.splice(0, aEcrire.length)
      try { stats.tradesEcrits += await live.ajouterTrades(lot) } catch (e) {
        log.warn({ err: e.message, lot: lot.length }, 'trades non écrits')
      }
    }
    const sales = []
    for (const e of etats.values()) if (e.sale && e.persiste) { e.sale = false; sales.push(e) }
    if (sales.length) {
      try { await live.majLive(sales) } catch (err) {
        for (const e of sales) e.sale = true
        log.warn({ err: err.message }, 'état temps réel non écrit')
      }
    }
  } finally {
    ecritureEnCours = false
  }
}

async function rafraichirCours() {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${WSOL}`, { signal: AbortSignal.timeout(8000) })
    const paires = await r.json()
    const p = (Array.isArray(paires) ? paires : [])
      .filter(x => ['USDC', 'USDT'].includes(x.quoteToken?.symbol))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
    const v = Number(p?.priceUsd)
    if (v > 0) { solUsd = v; solUsdA = Date.now() }
  } catch (e) {
    // Le dernier cours connu reste en usage : le SOL ne bouge pas de 10 % en
    // une minute, alors qu'un cours absent annulerait toutes les mesures en $.
    log.warn({ err: e.message, dernier: solUsd }, 'cours du SOL indisponible')
  }
}

const RPC_PUBLIC = 'https://api.mainnet-beta.solana.com'
const horsServiceJusqua = new Map()     // url → instant de retour en service

/**
 * Appel RPC HTTP ponctuel : Alchemy s'il est configuré, puis le RPC public.
 *
 * Un quota épuisé chez l'un ne doit pas interrompre l'autre. Observé : Alchemy
 * renvoyait « Monthly capacity limit exceeded » en boucle, et la résolution
 * des pools s'arrêtait net alors que le RPC public répondait normalement.
 * Un refus 429 écarte le fournisseur dix minutes plutôt qu'à chaque appel.
 */
async function rpcHttp(method, params) {
  const urls = [fournisseur('alchemy')?.httpUrl, RPC_PUBLIC].filter(Boolean)
  let derniere = null
  for (const url of urls) {
    if ((horsServiceJusqua.get(url) ?? 0) > Date.now()) continue
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000)
      })
      const j = await r.json().catch(() => null)
      if (r.status === 429 || j?.error?.code === 429) {
        horsServiceJusqua.set(url, Date.now() + 10 * 60_000)
        // Jamais l'URL dans le journal : celle d'Alchemy porte la clé.
        derniere = new Error(`${method} : quota atteint (${j?.error?.message ?? 'HTTP 429'})`)
        continue
      }
      if (!j) throw new Error(`${method} : HTTP ${r.status}`)
      if (j.error) throw new Error(`${method} : ${j.error.message}`)
      return j.result
    } catch (e) {
      derniere = e
    }
  }
  throw derniere ?? new Error(`${method} : aucun point d'accès RPC disponible`)
}

let resolutionPauseJusqua = 0

/** Relie les pools PumpSwap inconnus à leur mint, par lots de 20 comptes. */
async function resoudrePools() {
  if (resolutionEnCours || !aResoudre.size || Date.now() < resolutionPauseJusqua) return
  resolutionEnCours = true
  const lot = [...aResoudre].slice(0, 20)
  try {
    const r = await rpcHttp('getMultipleAccounts', [lot, { encoding: 'base64' }])
    lot.forEach((pool, k) => {
      aResoudre.delete(pool)
      const v = r?.value?.[k]
      const p = v ? decoderPool(v.data[0]) : null
      if (!p) { poolsIllisibles.add(pool); stats.poolsEnEchec++; return }
      const info = { mint: p.mint, quoteMint: p.quoteMint, baseDec: null, quoteDec: null }
      pools.set(pool, info)
      stats.poolsResolus++
      live.enregistrerPool({ pool, ...info }).catch(() => { /* retentée au prochain trade */ })
      const e = etats.get(p.mint)
      if (e && !e.pool) { e.pool = pool; e.sale = true }
    })
  } catch (e) {
    // Plafond par seconde du fournisseur, le plus souvent : le lot reste en
    // file et repartira au prochain passage.
    log.warn({ err: e.message, pools: lot.length }, 'résolution de pools reportée')
  } finally {
    resolutionEnCours = false
  }
}

/** Oublie les tokens retombés dans l'inactivité. */
function elaguer(now) {
  const aArchiver = []
  for (const [mint, e] of etats) {
    const dernier = e.dernierTradeA ?? e.vuA
    const alerte = e.alertes.entree?.decision === 'alerted'
    const limite = alerte ? S.suiviHeures * 3_600_000 : S.inactifMin * 60_000
    if (now - dernier <= limite) continue
    etats.delete(mint)
    noterCreateur(e.creator, -1)
    // Seuls les tokens jamais évalués sont archivés : un rejet garde son
    // statut `quarantine`, une alerte le sien.
    if (e.persiste && !e.alertes.entree) aArchiver.push(live.idToken(mint))
  }
  if (aArchiver.length) {
    live.archiver(aArchiver).then(n => { stats.archives += n })
      .catch(err => log.warn({ err: err.message }, 'archivage en échec'))
  }
  for (const [sig, t] of vues) if (now - t > 120_000) vues.delete(sig)
}

/** Reconstruit l'état d'un token depuis la base, après un redémarrage. */
function etatDepuisDoc(d) {
  const l = d.live ?? {}
  const e = creerEtat({
    mint: d.address, symbol: d.symbol, name: d.name, creator: d.deployer,
    createdAt: d.created_at ? +d.created_at : null, complet: Boolean(l.complet),
    vuA: d.discovered_at ? +d.discovered_at : Date.now()
  })
  e.supply = d.supply ?? null
  e.mc = l.mc ?? null
  e.mcMax = l.mc_max ?? 0
  e.prix = l.price_usd ?? null
  e.n = l.trades ?? 0
  e.achats = l.buys ?? 0
  e.ventes = l.sells ?? 0
  e.usdConnus = l.micro_sample ?? 0
  e.micro = Math.round((l.micro_share ?? 0) * e.usdConnus)
  e.volumeUsd = l.volume_usd ?? 0
  e.premiers = (l.first_buyers ?? []).map(p => ({ wallet: p.wallet, rang: p.rank, ts: +p.ts }))
  // Les premiers acheteurs restent des acheteurs : sans cela, leur prochain
  // achat les ferait passer pour de nouveaux venus.
  for (const p of e.premiers) e.wallets.set(p.wallet, { achats: 1, ventes: 0, tokensAchetes: 0, tokensVendus: 0, premierTs: p.ts })
  e.gradue = Boolean(l.graduated)
  e.gradueA = l.graduated_at ? +l.graduated_at : null
  e.pool = l.pool ?? null
  e.auteursFiges = l.authors ?? null
  e.ventesAuteursAvant = l.authors_sold_before_entry ?? 0
  e.ventesAuteurs = new Map((l.author_sells ?? []).map(v => [v.wallet, { ts: +v.ts, tokens: v.tokens }]))
  const a = l.alerts ?? {}
  e.alertes = {
    entree: a.entry ? { ...a.entry, at: +a.entry.at } : null,
    x10: a.x10 ? { ...a.x10, at: +a.x10.at } : null,
    auteurs: a.authors ? { ...a.authors, at: +a.authors.at } : null
  }
  e.entreeEvaluee = Boolean(a.entry)
  e.persiste = true
  e.etude = Boolean(l.study)
  e.temoin = Boolean(l.control)
  e.dernierTradeA = l.updated_at ? +l.updated_at : null
  return e
}

function journal() {
  let enEtude = 0, persistes = 0, gradues = 0
  for (const e of etats.values()) {
    if (e.etude) enEtude++
    if (e.persiste) persistes++
    if (e.gradue) gradues++
  }
  log.info({
    ...stats, suivis: etats.size, en_etude: enEtude, en_base: persistes, gradues_suivis: gradues,
    pools: pools.size, pools_en_attente: aResoudre.size, snipers: snipers.taille,
    sol_usd: solUsd, cours_age_s: solUsdA ? Math.round((Date.now() - solUsdA) / 1000) : null,
    connexions: connexions.map(c => ({ source: c.nom, messages: c.stats.messages, reconnexions: c.stats.reconnexions }))
  }, 'flux pump.fun')
}

// --- cycle de vie ---------------------------------------------------------------------

export async function demarrerFlux(cfg) {
  if (connexions.length) return statsFlux()
  cfgCourante = cfg
  S = reglages(cfg)
  snipers = new Snipers({ seuil: S.snipersSeuil })

  await live.assurerIndex()
  for (const [pool, info] of await live.chargerPools()) pools.set(pool, info)
  for (const d of await live.chargerSuivis(new Date(Date.now() - S.suiviHeures * 3_600_000))) {
    const e = etatDepuisDoc(d)
    etats.set(e.mint, e)
    noterCreateur(e.creator, +1)
  }

  // Le cours d'abord : sans lui, aucun trade n'a de montant en dollars.
  await rafraichirCours()

  const urls = [...S.endpoints]
  const qn = fournisseur('quicknode')
  if (qn) urls.push(qn.wsUrl)
  for (const url of urls) {
    const c = new Connexion(url)
    connexions.push(c)
    c.ouvrir()
  }

  minuteurs.push(setInterval(() => { ecrire().catch(() => { /* journalisé dans ecrire */ }) }, S.ecritureMs))
  minuteurs.push(setInterval(() => { resoudrePools() }, 500))
  minuteurs.push(setInterval(() => {
    const now = Date.now()
    for (const c of connexions) c.surveiller(now)
    elaguer(now)
  }, 15_000))
  minuteurs.push(setInterval(() => { rafraichirCours() }, 60_000))
  minuteurs.push(setInterval(() => snipers.purger(), 10 * 60_000))
  minuteurs.push(setInterval(journal, 60_000))

  log.info({
    sources: connexions.map(c => c.nom), entree_mc: S.entreeMc, repris: etats.size,
    pools: pools.size, sol_usd: solUsd, exclus: S.exclus
  }, 'flux pump.fun démarré')
  return statsFlux()
}

/** Prend en compte une nouvelle version de configuration sans redémarrer. */
export function actualiserConfig(cfg) {
  if (!cfgCourante) return
  cfgCourante = cfg
  S = reglages(cfg)
}

export async function arreterFlux() {
  for (const c of connexions) c.fermer()
  connexions.length = 0
  for (const m of minuteurs) clearInterval(m)
  minuteurs.length = 0
  await ecrire().catch(() => { /* dernière tentative */ })
}

export function statsFlux() {
  return { ...stats, suivis: etats.size, pools: pools.size, sol_usd: solUsd, connexions: connexions.length }
}
