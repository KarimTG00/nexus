/**
 * État temps réel d'un token pump.fun — fonctions pures, sans entrée/sortie.
 *
 * Tout ce qui décide d'une alerte vit ici, séparé de la connexion et de la
 * base : c'est la partie qui doit être juste, donc celle qu'on teste sans
 * réseau, sur des séquences de trades construites à la main.
 *
 * Quatre questions, auxquelles l'état répond à chaque trade :
 *   1. ce token fabrique-t-il son activité ?  → part des trades sous 1 $
 *   2. de vrais acheteurs arrivent-ils ?        → wallets achetant au-dessus
 *   3. qui sont ses auteurs, et tiennent-ils encore ?
 *   4. faut-il alerter ?                        → entrée, paliers, ventes d'auteurs
 */

const MIN = 60_000
const FENETRES = { '5min': 5, '15min': 15, '1h': 60 }

/**
 * `complet: false` pour un token dont on n'a pas vu la création — né pendant
 * une coupure de l'écoute. Ses premiers acheteurs sont inconnus, donc ses
 * auteurs aussi : on le suit, mais on ne prétend pas savoir qui vend.
 */
export function creerEtat({ mint, symbol = null, name = null, uri = null, creator = null,
  curve = null, createdAt = null, complet = true, vuA = Date.now() }) {
  return {
    mint, symbol, name, uri, creator, curve, createdAt, vuA, complet,
    pool: null, gradue: false, gradueA: null,

    n: 0, achats: 0, ventes: 0,
    micro: 0,          // trades sous le seuil, parmi ceux dont on connaît le montant en $
    usdConnus: 0,
    volumeUsd: 0,
    acheteursReels: 0, // wallets distincts ayant acheté AU-DESSUS du seuil

    premiers: [],      // premiers acheteurs DISTINCTS, dans l'ordre : { wallet, ts, rang }
    wallets: new Map(),
    recents: [],       // fenêtre glissante d'une heure : { ts, wallet, cote, usd }

    prix: null, mc: null, mcMax: 0, dernierTradeA: null,
    // Liquidité réelle du pool, lue sur les réserves à chaque trade.
    liquiditeUsd: null,

    // Une seule évaluation d'entrée par token, comme un palier de l'ancien
    // pipeline : le snapshot qui en résulte est unique et append-only.
    entreeEvaluee: false,
    // `multiples` : paliers de sortie déjà signalés — { multiple, at, mc }.
    alertes: { entree: null, multiples: [], auteurs: null },
    auteursFiges: null,        // liste arrêtée à l'alerte d'entrée
    partAuteurs: null,         // part de l'offre qu'ils détiennent encore
    ventesAuteurs: new Map(),  // auteur → première vente APRÈS l'entrée
    ventesAuteursAvant: 0      // auteurs ayant déjà vendu avant l'entrée
  }
}

/**
 * Applique un trade.
 * @param t { ts, wallet, cote, tokens, usd|null, prixUsd|null, mcUsd|null,
 *            liquiditeUsd|null, venue }
 */
export function appliquerTrade(e, t, { maxPremiers = 20, microUsd = 1, now = Date.now() } = {}) {
  e.n++
  if (t.cote === 'buy') e.achats++; else e.ventes++

  const usdConnu = t.usd !== null && t.usd !== undefined && Number.isFinite(t.usd)
  if (usdConnu) {
    e.usdConnus++
    e.volumeUsd += t.usd
    if (t.usd < microUsd) e.micro++
  }

  let w = e.wallets.get(t.wallet)
  const nouvelAcheteur = t.cote === 'buy' && (!w || w.achats === 0)
  if (!w) { w = { achats: 0, ventes: 0, achatsReels: 0, tokensAchetes: 0, tokensVendus: 0, premierTs: t.ts }; e.wallets.set(t.wallet, w) }
  if (t.cote === 'buy') {
    w.achats++
    w.tokensAchetes += t.tokens ?? 0
    // Un wallet ne compte qu'une fois comme acheteur réel, quel que soit le
    // nombre d'achats : sinon un seul acteur suffirait à simuler une foule.
    if (usdConnu && t.usd >= microUsd) { if (w.achatsReels === 0) e.acheteursReels++; w.achatsReels++ }
  } else {
    w.ventes++
    w.tokensVendus += t.tokens ?? 0
  }

  if (nouvelAcheteur && e.premiers.length < maxPremiers) {
    e.premiers.push({ wallet: t.wallet, ts: t.ts, rang: e.premiers.length + 1 })
  }

  if (t.prixUsd !== null && t.prixUsd !== undefined) e.prix = t.prixUsd
  if (t.liquiditeUsd !== null && t.liquiditeUsd !== undefined && Number.isFinite(t.liquiditeUsd)) {
    e.liquiditeUsd = t.liquiditeUsd
  }
  if (t.mcUsd !== null && t.mcUsd !== undefined && Number.isFinite(t.mcUsd)) {
    e.mc = t.mcUsd
    if (t.mcUsd > e.mcMax) e.mcMax = t.mcUsd
  }

  // Une vente d'auteur ne compte qu'une fois par auteur, et seulement après
  // l'entrée : c'est le signal « ils commencent à sortir » que l'alerte vise.
  if (e.auteursFiges?.includes(t.wallet)) {
    if (t.cote === 'sell' && !e.ventesAuteurs.has(t.wallet)) {
      e.ventesAuteurs.set(t.wallet, { ts: t.ts, tokens: t.tokens ?? null })
    }
    e.partAuteurs = partDetenue(e, e.auteursFiges)
  }

  e.recents.push({ ts: t.ts, wallet: t.wallet, cote: t.cote, usd: t.usd ?? null })
  const limite = now - 60 * MIN
  let i = 0
  while (i < e.recents.length && e.recents[i].ts < limite) i++
  if (i) e.recents.splice(0, i)

  e.dernierTradeA = t.ts
  return e
}

/** Part des trades sous le seuil, parmi ceux dont le montant en $ est connu. */
export function partMicro(e) {
  return e.usdConnus ? e.micro / e.usdConnus : null
}

/**
 * Part de l'offre encore détenue par une liste de wallets, d'après NOTRE
 * registre de trades — donc valable seulement pour un token suivi depuis sa
 * création (`complet`). Un token repris en cours de route rend `null` plutôt
 * qu'un chiffre faux.
 */
export function partDetenue(e, wallets) {
  if (!e.complet || !wallets?.length) return null
  const offre = e.supply ?? 1e9
  if (!(offre > 0)) return null
  let restant = 0
  for (const w of wallets) {
    const x = e.wallets.get(w)
    if (x) restant += Math.max(0, (x.tokensAchetes ?? 0) - (x.tokensVendus ?? 0))
  }
  return +(restant / offre).toFixed(6)
}

/**
 * Fenêtres au format de Mobula (`buyers`, `sellers`, `traders`, `buys`…), pour
 * que les filtres et le score existants lisent nos mesures sans adaptation.
 * La différence : ici ce sont des comptes exacts, pas ceux d'un agrégateur.
 *
 * `buyersReels` compte en plus les acheteurs au-dessus du seuil de micro-trade.
 */
export function fenetres(e, now = Date.now(), { microUsd = 1 } = {}) {
  const out = {}
  for (const [nom, minutes] of Object.entries(FENETRES)) {
    const depuis = now - minutes * MIN
    const acheteurs = new Set(), vendeurs = new Set(), traders = new Set(), reels = new Set()
    let buys = 0, sells = 0, vol = 0, volConnu = false
    for (const r of e.recents) {
      if (r.ts < depuis) continue
      traders.add(r.wallet)
      if (r.cote === 'buy') {
        buys++
        acheteurs.add(r.wallet)
        if (r.usd !== null && r.usd >= microUsd) reels.add(r.wallet)
      } else {
        sells++
        vendeurs.add(r.wallet)
      }
      if (r.usd !== null) { vol += r.usd; volConnu = true }
    }
    out[nom] = {
      buyers: acheteurs.size, sellers: vendeurs.size, traders: traders.size,
      buyersReels: reels.size,
      buys, sells, trades: buys + sells, volumeUsd: volConnu ? vol : null
    }
  }
  return out
}

/**
 * Auteurs : le créateur et les premiers acheteurs, snipers exclus.
 *
 * Les snipers sont des bots qui achètent dans les premières secondes de
 * CENTAINES de tokens et revendent à ×2. Ils sont parmi les premiers
 * acheteurs sans être des auteurs, et leur prise de bénéfice déclencherait
 * une fausse alerte de dump sur presque chaque token.
 */
export function auteurs(e, { nbPremiers = 10, estSniper = () => false } = {}) {
  const liste = []
  if (e.creator) liste.push(e.creator)
  for (const p of e.premiers.slice(0, nbPremiers)) {
    if (!liste.includes(p.wallet) && !estSniper(p.wallet)) liste.push(p.wallet)
  }
  return liste
}

/** Fige les auteurs au moment de l'entrée ; note ceux qui avaient déjà vendu. */
export function figerAuteurs(e, liste) {
  e.auteursFiges = liste
  e.ventesAuteursAvant = liste.filter(w => (e.wallets.get(w)?.ventes ?? 0) > 0).length
  e.partAuteurs = partDetenue(e, liste)
}

/** Multiple atteint depuis l'entrée, ou `null` si l'entrée n'a pas eu lieu. */
export function multipleAtteint(e) {
  const entree = e.alertes.entree
  if (!entree || !(entree.mc > 0) || e.mc === null) return null
  return e.mc / entree.mc
}

/** Paliers franchis et pas encore signalés. */
export function paliersDus(e, multiples = []) {
  const atteint = multipleAtteint(e)
  if (atteint === null) return []
  return multiples.filter(m => atteint >= m && !e.alertes.multiples.some(x => x.multiple === m))
}

/**
 * Ce qu'il faut faire maintenant pour ce token.
 * @param s { entreeMc, multiples, auteursMin }
 * @returns liste d'actions : 'entree' | 'x<multiple>' | 'auteurs'
 */
export function decisions(e, s) {
  const out = []
  if (!e.entreeEvaluee && e.mc !== null && e.mc >= s.entreeMc) out.push('entree')

  // Les sorties ne concernent qu'une entrée réellement envoyée : suivre la
  // sortie d'un token rejeté n'aurait aucun lecteur.
  const entree = e.alertes.entree
  if (entree?.decision === 'alerted') {
    // Sorties échelonnées. On ne signale que le PLUS HAUT palier franchi et
    // pas encore signalé : un token qui saute de ×1 à ×40 en un seul trade
    // produit une alerte « ×30 », pas trois alertes d'affilée.
    const dus = paliersDus(e, s.multiples ?? [])
    if (dus.length) out.push(`x${Math.max(...dus)}`)

    // Sans ses premiers acheteurs, un token n'a pas d'auteurs connus :
    // compter ses ventes d'auteurs mesurerait le seul créateur.
    if (!e.alertes.auteurs && e.complet && e.ventesAuteurs.size >= s.auteursMin) out.push('auteurs')
  }
  return out
}

/**
 * Registre des snipers : un wallet parmi les premiers acheteurs de trop de
 * tokens distincts sur une fenêtre glissante. Reconnu par RÉCURRENCE, comme
 * l'infrastructure EVM — jamais par la taille d'un achat.
 */
export class Snipers {
  constructor({ fenetreMs = 24 * 3600_000, seuil = 5 } = {}) {
    this.fenetreMs = fenetreMs
    this.seuil = seuil
    this.vus = new Map()     // wallet → horodatages
  }

  noter(wallet, ts) {
    const l = this.vus.get(wallet)
    if (l) l.push(ts); else this.vus.set(wallet, [ts])
  }

  est(wallet, now = Date.now()) {
    const l = this.vus.get(wallet)
    if (!l) return false
    const depuis = now - this.fenetreMs
    let n = 0
    for (const t of l) if (t >= depuis) n++
    return n >= this.seuil
  }

  purger(now = Date.now()) {
    const depuis = now - this.fenetreMs
    for (const [w, l] of this.vus) {
      const garde = l.filter(t => t >= depuis)
      if (garde.length) this.vus.set(w, garde); else this.vus.delete(w)
    }
  }

  get taille() { return this.vus.size }
}
