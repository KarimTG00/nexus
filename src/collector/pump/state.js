/**
 * État temps réel d'un token pump.fun — fonctions pures, sans entrée/sortie.
 *
 * Tout ce qui décide d'une alerte vit ici, séparé de la connexion et de la
 * base : c'est la partie qui doit être juste, donc celle qu'on teste sans
 * réseau, sur des séquences de trades construites à la main.
 *
 * Trois questions, auxquelles l'état répond à chaque trade :
 *   1. ce token fabrique-t-il son activité ?  → part des trades sous 1 $
 *   2. qui sont ses auteurs ?                   → créateur + premiers acheteurs
 *   3. faut-il alerter ?                        → entrée, ×10, ventes d'auteurs
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

    premiers: [],      // premiers acheteurs DISTINCTS, dans l'ordre : { wallet, ts, rang }
    wallets: new Map(),
    recents: [],       // fenêtre glissante d'une heure : { ts, wallet, cote, usd }

    prix: null, mc: null, mcMax: 0, dernierTradeA: null,

    // Une seule évaluation d'entrée par token, comme un palier de l'ancien
    // pipeline : le snapshot qui en résulte est unique et append-only.
    entreeEvaluee: false,
    alertes: { entree: null, x10: null, auteurs: null },
    auteursFiges: null,        // liste arrêtée à l'alerte d'entrée
    ventesAuteurs: new Map(),  // auteur → première vente APRÈS l'entrée
    ventesAuteursAvant: 0      // auteurs ayant déjà vendu avant l'entrée
  }
}

/**
 * Applique un trade.
 * @param t { ts, wallet, cote, tokens, usd|null, prixUsd|null, mcUsd|null, venue }
 */
export function appliquerTrade(e, t, { maxPremiers = 20, microUsd = 1, now = Date.now() } = {}) {
  e.n++
  if (t.cote === 'buy') e.achats++; else e.ventes++

  if (t.usd !== null && t.usd !== undefined && Number.isFinite(t.usd)) {
    e.usdConnus++
    e.volumeUsd += t.usd
    if (t.usd < microUsd) e.micro++
  }

  let w = e.wallets.get(t.wallet)
  const nouvelAcheteur = t.cote === 'buy' && (!w || w.achats === 0)
  if (!w) { w = { achats: 0, ventes: 0, tokensAchetes: 0, tokensVendus: 0, premierTs: t.ts }; e.wallets.set(t.wallet, w) }
  if (t.cote === 'buy') { w.achats++; w.tokensAchetes += t.tokens ?? 0 }
  else { w.ventes++; w.tokensVendus += t.tokens ?? 0 }

  if (nouvelAcheteur && e.premiers.length < maxPremiers) {
    e.premiers.push({ wallet: t.wallet, ts: t.ts, rang: e.premiers.length + 1 })
  }

  if (t.prixUsd !== null && t.prixUsd !== undefined) e.prix = t.prixUsd
  if (t.mcUsd !== null && t.mcUsd !== undefined && Number.isFinite(t.mcUsd)) {
    e.mc = t.mcUsd
    if (t.mcUsd > e.mcMax) e.mcMax = t.mcUsd
  }

  // Une vente d'auteur ne compte qu'une fois par auteur, et seulement après
  // l'entrée : c'est le signal « ils commencent à sortir » que l'alerte vise.
  if (t.cote === 'sell' && e.auteursFiges?.includes(t.wallet) && !e.ventesAuteurs.has(t.wallet)) {
    e.ventesAuteurs.set(t.wallet, { ts: t.ts, tokens: t.tokens ?? null })
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
 * Fenêtres au format de Mobula (`buyers`, `sellers`, `traders`, `buys`…), pour
 * que les filtres et le score existants lisent nos mesures sans adaptation.
 * La différence : ici ce sont des comptes exacts, pas ceux d'un agrégateur.
 */
export function fenetres(e, now = Date.now()) {
  const out = {}
  for (const [nom, minutes] of Object.entries(FENETRES)) {
    const depuis = now - minutes * MIN
    const acheteurs = new Set(), vendeurs = new Set(), traders = new Set()
    let buys = 0, sells = 0, vol = 0, volConnu = false
    for (const r of e.recents) {
      if (r.ts < depuis) continue
      traders.add(r.wallet)
      if (r.cote === 'buy') { buys++; acheteurs.add(r.wallet) } else { sells++; vendeurs.add(r.wallet) }
      if (r.usd !== null) { vol += r.usd; volConnu = true }
    }
    out[nom] = {
      buyers: acheteurs.size, sellers: vendeurs.size, traders: traders.size,
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
}

/**
 * Ce qu'il faut faire maintenant pour ce token.
 * @param s { entreeMc, multipleSortie, auteursMin }
 * @returns liste d'actions : 'entree' | 'x10' | 'auteurs'
 */
export function decisions(e, s) {
  const out = []
  if (!e.entreeEvaluee && e.mc !== null && e.mc >= s.entreeMc) out.push('entree')

  // Les sorties ne concernent qu'une entrée réellement envoyée : suivre la
  // sortie d'un token rejeté n'aurait aucun lecteur.
  const entree = e.alertes.entree
  if (entree?.decision === 'alerted') {
    if (!e.alertes.x10 && e.mc !== null && entree.mc > 0 && e.mc >= entree.mc * s.multipleSortie) out.push('x10')
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
