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
    recents: [],       // fenêtre glissante d'une heure : { ts, wallet, cote, usd, mc }

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
    ventesAuteursAvant: 0,     // auteurs ayant déjà vendu avant l'entrée

    // Trajectoire : instant du sommet, et première retombée à la moitié du
    // sommet d'alors — la vitesse de la chute décide du temps pour sortir.
    mcMaxA: null,
    premiereMoitie: null,      // { ts, sommet, sommetA }

    // Graduation : `usine` est vrai quand elle a lieu dans la seconde de la
    // création — le saut fabriqué, impossible à capter.
    usine: null,
    graduation: null,          // { mcCourbe, mcAmm }

    // Seuils de mesure déjà jugés (retenus ou écartés) : chacun une seule fois.
    croisements: new Set(),

    // Bougies, par série (`m1`, `s10`) : { ouverte, fermees } — celle en cours
    // et celles fermées pas encore écrites. `bougiesDepuis` est l'instant
    // (chaîne) de la première : les fenêtres d'enregistrement partent de là.
    series: {},
    bougiesDepuis: null
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
  const mcConnue = t.mcUsd !== null && t.mcUsd !== undefined && Number.isFinite(t.mcUsd)
  if (mcConnue) {
    e.mc = t.mcUsd
    if (t.mcUsd > e.mcMax) { e.mcMax = t.mcUsd; e.mcMaxA = t.ts }
    if (!e.premiereMoitie && e.mcMax > 0 && t.mcUsd <= e.mcMax / 2) {
      e.premiereMoitie = { ts: t.ts, sommet: e.mcMax, sommetA: e.mcMaxA }
    }
    // Taille du saut de graduation : la capitalisation au premier trade PumpSwap.
    if (e.graduation && e.graduation.mcAmm === null && t.venue === 'amm') e.graduation.mcAmm = t.mcUsd
  }

  // Une vente d'auteur ne compte qu'une fois par auteur, et seulement après
  // l'entrée : c'est le signal « ils commencent à sortir » que l'alerte vise.
  if (e.auteursFiges?.includes(t.wallet)) {
    if (t.cote === 'sell' && !e.ventesAuteurs.has(t.wallet)) {
      e.ventesAuteurs.set(t.wallet, { ts: t.ts, tokens: t.tokens ?? null })
    }
    e.partAuteurs = partDetenue(e, e.auteursFiges)
  }

  // La capitalisation de chaque trade est gardée dans la fenêtre : c'est ce
  // qui permet de dire dans quel SENS le token se déplace au moment d'une
  // alerte, et pas seulement où il se trouve.
  e.recents.push({ ts: t.ts, wallet: t.wallet, cote: t.cote, usd: t.usd ?? null, mc: mcConnue ? t.mcUsd : null })
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
 * En plus : `buyersReels` (acheteurs au-dessus du seuil de micro-trade) et
 * `mcDebut`, la capitalisation au premier trade de la fenêtre — de quoi dire
 * si le token monte ou descend.
 */
export function fenetres(e, now = Date.now(), { microUsd = 1 } = {}) {
  const out = {}
  for (const [nom, minutes] of Object.entries(FENETRES)) {
    const depuis = now - minutes * MIN
    const acheteurs = new Set(), vendeurs = new Set(), traders = new Set(), reels = new Set()
    let buys = 0, sells = 0, vol = 0, volConnu = false
    let mcDebut = null
    for (const r of e.recents) {
      if (r.ts < depuis) continue
      if (mcDebut === null && r.mc !== null && r.mc !== undefined) mcDebut = r.mc
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
      buys, sells, trades: buys + sells, volumeUsd: volConnu ? vol : null,
      mcDebut,
      variation: mcDebut && e.mc !== null ? e.mc / mcDebut - 1 : null
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
 * Le token est-il seulement ÉVALUABLE à l'entrée ?
 *
 * Ces conditions ne jugent pas le token : elles vérifient qu'on a de quoi le
 * juger. Sans elles, l'entrée partait sur des tokens qu'on ne savait pas lire
 * — observé en production, des alertes « 0 % sur 1 trade, 0 auteurs ».
 */
export function peutEvaluerEntree(e, s) {
  if (e.entreeEvaluee) return false
  if (e.mc === null || e.mc < s.entreeMc) return false

  // Sans CreateEvent, ses premiers acheteurs sont inconnus, donc ses auteurs
  // aussi : l'alerte de sortie sur vente d'auteur serait impossible, et
  // l'entrée n'aurait aucune sortie à proposer.
  if (!e.complet) return false

  // Trop peu de trades mesurés : `micro_trades` s'abstiendrait faute
  // d'échantillon, et comme il est l'un des deux seuls filtres bloquants,
  // son abstention vaudrait feu vert. Une absence de mesure n'est pas un
  // succès — ici elle veut dire « pas encore évaluable ».
  if (e.usdConnus < (s.microMinEchantillon ?? 0)) return false

  // Uniquement une traversée MONTANTE de la bande. On compare le SOMMET déjà
  // atteint au plafond, pas la capitalisation du moment : un token qui a
  // dépassé la bande puis y redescend est dans la bande, complet et riche en
  // trades — et l'entrée partait en pleine chute. Observé en production sur
  // BEAST : alerte à 115 K pendant l'effondrement d'un token monté à 4,6 M.
  // Le sommet inclut la capitalisation courante, donc cette condition couvre
  // aussi le token qui arrive directement au-dessus de la bande.
  if (s.entreeMaxRatio && e.mcMax > s.entreeMc * s.entreeMaxRatio) return false

  // Organiques seulement. Un token d'usine gradue dans la seconde de sa
  // création : l'évaluer produirait une alerte sur un mouvement terminé.
  if (s.organiqueSeul && !estOrganique(e, s)) return false

  return true
}

/**
 * Le token se construit-il sur la courbe ? Vrai tant qu'il n'a pas gradué et
 * qu'il a vécu au moins `ageOrganiqueMs` — en temps de la chaîne (dernier
 * trade − création), pas en temps de réception.
 */
export function estOrganique(e, s) {
  if (e.gradue || !e.createdAt || e.dernierTradeA === null) return false
  return e.dernierTradeA - e.createdAt >= (s.ageOrganiqueMs ?? 0)
}

/**
 * Graduation, notée une seule fois au premier signe (CompleteEvent ou premier
 * trade PumpSwap). `usine` n'est tranché que pour un token vu depuis sa
 * création : sans elle, le délai est inconnu.
 * @returns {boolean} vrai si la graduation vient d'être notée
 */
export function marquerGraduation(e, ts, { usineMaxMs = 2000 } = {}) {
  if (e.gradue) return false
  e.gradue = true
  e.gradueA = ts
  e.usine = e.complet && e.createdAt ? ts - e.createdAt <= usineMaxMs : null
  e.graduation = { mcCourbe: e.mc, mcAmm: null }
  return true
}

/**
 * Seuils de mesure franchis et pas encore jugés.
 *
 * Chaque seuil est jugé UNE fois, au premier trade qui le franchit : retenu
 * pour une montée organique, écarté sinon, avec la raison. L'appelant marque
 * le seuil dans `e.croisements` dans les deux cas — sans quoi un token écarté
 * serait rejugé à chaque trade, et finirait retenu en redescendant.
 */
export function croisementsDus(e, s) {
  const out = []
  if (!s.mesureMc?.length || e.mc === null) return out
  for (const seuil of s.mesureMc) {
    if (e.croisements.has(seuil) || e.mc < seuil) continue
    let raison = null
    if (!e.complet) raison = 'creation_non_vue'
    else if (e.gradue) raison = e.usine ? 'usine' : 'gradue'
    else if (!estOrganique(e, s)) raison = 'trop_jeune'
    else if (s.entreeMaxRatio && e.mcMax > seuil * s.entreeMaxRatio) raison = 'deja_passe'
    out.push({ seuil, retenu: raison === null, raison })
  }
  return out
}

/**
 * Ce qu'on sait d'un token à l'instant où il franchit un seuil, calculé sur
 * notre seul registre de trades. Ces mesures ne décident rien : M10 compare
 * leur pouvoir séparateur entre les tokens qui montent et ceux qui meurent,
 * et c'est ce pouvoir, mesuré, qui en fera des filtres.
 */
export function signauxCroisement(e, { now = Date.now(), microUsd = 1, nbAuteurs = 10, estSniper = () => false } = {}) {
  const offre = e.supply ?? 1e9
  const w5 = fenetres(e, now, { microUsd })['5min']

  const depuis = now - MIN
  const acheteurs1 = new Set()
  let achats1 = 0, ventes1 = 0, volume1 = 0
  for (const r of e.recents) {
    if (r.ts < depuis) continue
    if (r.cote === 'buy') { achats1++; acheteurs1.add(r.wallet) } else ventes1++
    if (r.usd !== null) volume1 += r.usd
  }

  // Soldes nets d'après notre registre : valables pour un token complet.
  const soldes = []
  let acheteurs = 0
  for (const x of e.wallets.values()) {
    if (x.achats > 0) acheteurs++
    const solde = (x.tokensAchetes ?? 0) - (x.tokensVendus ?? 0)
    if (solde > 0) soldes.push(solde)
  }
  soldes.sort((a, b) => b - a)
  const top10 = +(soldes.slice(0, 10).reduce((s, x) => s + x, 0) / offre).toFixed(6)

  const dev = e.creator ? e.wallets.get(e.creator) : null
  const premiers = e.premiers.slice(0, nbAuteurs)
  // Acheteurs de la première seconde, créateur exclu : le groupe préparé
  // d'avance, quand il y en a un.
  const bloc0 = e.createdAt ? e.premiers.filter(p => p.wallet !== e.creator && p.ts - e.createdAt <= 1000) : []
  const part = e.usdConnus ? e.micro / e.usdConnus : null

  return {
    age_s: e.createdAt && e.dernierTradeA !== null ? Math.round((e.dernierTradeA - e.createdAt) / 1000) : null,
    mc: e.mc,
    liquidite_usd: e.liquiditeUsd === null ? null : Math.round(e.liquiditeUsd),
    trades: e.n,
    achats: e.achats,
    ventes: e.ventes,
    ratio_achats_ventes: e.ventes ? +(e.achats / e.ventes).toFixed(3) : null,
    acheteurs,
    acheteurs_reels: e.acheteursReels,
    part_micro: part === null ? null : +part.toFixed(4),
    volume_usd: Math.round(e.volumeUsd),
    achats_1min: achats1,
    ventes_1min: ventes1,
    acheteurs_1min: acheteurs1.size,
    volume_1min_usd: Math.round(volume1),
    achats_5min: w5.buys,
    ventes_5min: w5.sells,
    acheteurs_reels_5min: w5.buyersReels,
    variation_5min: w5.variation === null ? null : +w5.variation.toFixed(3),
    detenteurs: soldes.length,
    part_top10: e.complet ? top10 : null,
    part_dev: e.complet && e.creator ? partDetenue(e, [e.creator]) : null,
    dev_a_vendu: Boolean(dev?.ventes),
    acheteurs_bloc0: bloc0.length,
    part_bloc0: e.complet && bloc0.length ? partDetenue(e, bloc0.map(p => p.wallet)) : 0,
    premiers_vendeurs: premiers.filter(p => (e.wallets.get(p.wallet)?.ventes ?? 0) > 0).length,
    premiers_snipers: premiers.filter(p => estSniper(p.wallet)).length
  }
}

/**
 * Ce qu'il faut faire maintenant pour ce token.
 * @param s { entreeMc, multiples, auteursMin }
 * @returns liste d'actions : 'entree' | 'x<multiple>' | 'auteurs'
 */
export function decisions(e, s) {
  const out = []
  if (peutEvaluerEntree(e, s)) out.push('entree')

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
 * Lancement recyclé : son nom a déjà servi, et plusieurs de ses premiers
 * acheteurs étaient déjà parmi les premiers acheteurs de ces lancements-là.
 * C'est la signature observée du groupe alpha : 62 tokens, les mêmes noms
 * relancés en boucle (WhiteBull ×12, Bulljak ×8…) par les mêmes wallets.
 *
 * Les wallets omniprésents (snipers achetant sous des centaines de noms) ne
 * comptent pas : sur un nom générique relancé 80 fois, deux d'entre eux
 * suffiraient à faire passer n'importe quel lancement pour une équipe.
 *
 * @param precedents [{ mint, premiers: Set }] lancements antérieurs du même nom
 */
export function evaluerRecyclage(e, precedents, { nbPremiers = 6, minRecurrents = 2, estOmnipresent = () => false } = {}) {
  const premiers = [...new Set(e.premiers.slice(0, nbPremiers + 1).map(p => p.wallet).filter(w => w !== e.creator))]
    .slice(0, nbPremiers)
  const autres = precedents.filter(p => p.mint !== e.mint)
  const recurrents = premiers.filter(w => !estOmnipresent(w) && autres.some(p => p.premiers.has(w)))
  return { premiers, precedents: autres.length, recurrents, recycle: autres.length > 0 && recurrents.length >= minRecurrents }
}

/**
 * Bougie de capitalisation, découpée sur l'heure de la CHAÎNE du trade et non
 * sur l'heure de réception : deux points d'accès livrent le même trade à
 * quelques centaines de millisecondes d'écart. Un trade antérieur à la bougie
 * ouverte (reprise après coupure) est ignoré : réécrire une bougie fermée
 * fausserait son ouverture et sa clôture.
 * Plusieurs séries coexistent (`serie`) : une minute sur plusieurs heures, et
 * dix secondes sur les premières minutes, là où se jouent la sortie et le stop.
 * @returns {boolean} vrai si le trade a été compté
 */
export function majBougie(e, t, { dureeMs = 60_000, serie = 'm1' } = {}) {
  if (!Number.isFinite(t.mcUsd)) return false
  const s = (e.series[serie] ??= { ouverte: null, fermees: [] })
  const debut = Math.floor(t.ts / dureeMs) * dureeMs
  let b = s.ouverte
  if (b && debut < b.debut) return false
  if (b && debut > b.debut) { fermerBougie(e, serie); b = null }
  if (!b) {
    b = s.ouverte = { debut, o: t.mcUsd, h: t.mcUsd, l: t.mcUsd, c: t.mcUsd,
      volumeUsd: 0, achats: 0, ventes: 0, acheteurs: new Set(), liquiditeUsd: null, venue: t.venue ?? null }
  }
  if (t.mcUsd > b.h) b.h = t.mcUsd
  if (t.mcUsd < b.l) b.l = t.mcUsd
  b.c = t.mcUsd
  if (Number.isFinite(t.usd)) b.volumeUsd += t.usd
  if (t.cote === 'buy') { b.achats++; b.acheteurs.add(t.wallet) } else b.ventes++
  if (Number.isFinite(t.liquiditeUsd)) b.liquiditeUsd = t.liquiditeUsd
  if (t.venue) b.venue = t.venue
  return true
}

/** Ferme la bougie ouverte d'une série et la range parmi celles à écrire. */
export function fermerBougie(e, serie = 'm1') {
  const s = e.series[serie]
  const b = s?.ouverte
  if (!b) return
  s.fermees.push({
    debut: b.debut, o: b.o, h: b.h, l: b.l, c: b.c,
    volumeUsd: Math.round(b.volumeUsd), achats: b.achats, ventes: b.ventes, acheteurs: b.acheteurs.size,
    liquiditeUsd: b.liquiditeUsd === null ? null : Math.round(b.liquiditeUsd), venue: b.venue
  })
  s.ouverte = null
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
