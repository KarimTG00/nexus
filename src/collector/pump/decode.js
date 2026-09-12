/**
 * Décodage des événements pump.fun (courbe) et PumpSwap (AMM).
 *
 * Les deux programmes publient chaque opération dans leurs journaux, sous la
 * forme d'une ligne `Program data: <base64>` : un discriminant de 8 octets
 * suivi de la structure encodée en Borsh. Un abonnement `logsSubscribe` livre
 * donc CHAQUE trade, avec wallet, montant et réserves, sans aucun appel
 * supplémentaire. Mesuré : ~200 trades de courbe décodés en 15 s.
 *
 * Le décodeur est piloté par l'IDL officiel (`idl.json`, sous-ensemble de
 * github.com/pump-fun/pump-public-docs) et non par des positions d'octets
 * codées en dur. Les événements évoluent : `TradeEvent` est passé de 8 à 32
 * champs, et trois tailles coexistaient dans une même capture (358, 359 et
 * 407 octets) parce que des chaînes et des listes y ont une longueur variable.
 * Un décalage fixe se serait trompé en silence sur une partie d'entre eux.
 *
 * Tolérance : un événement émis par une version antérieure du programme peut
 * être plus court que l'IDL. On décode alors jusqu'à la fin du tampon et on
 * marque le résultat `_tronque`. Les champs utiles au collecteur sont tous en
 * tête de structure, donc lisibles dans les deux cas.
 */

import { readFileSync } from 'node:fs'

const IDL = JSON.parse(readFileSync(new URL('./idl.json', import.meta.url), 'utf8'))

export const PUMP = IDL.programs.pump.address
export const PUMPSWAP = IDL.programs.pump_amm.address
export const WSOL = 'So11111111111111111111111111111111111111112'
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PUBKEY_NULLE = '11111111111111111111111111111111'

/** Décimales : les tokens pump.fun en ont 6, le SOL 9. */
export const DECIMALES_PUMP = 6
const DECIMALES_QUOTE = { [WSOL]: 9, [USDC]: 6 }

// --- base58 -----------------------------------------------------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58(buf) {
  let n = 0n
  for (const b of buf) n = n * 256n + BigInt(b)
  let s = ''
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n }
  for (const b of buf) { if (b !== 0) break; s = '1' + s }
  return s
}

// --- lecture Borsh ------------------------------------------------------------

class Lecteur {
  constructor(buf, o = 0) { this.buf = buf; this.o = o }

  avancer(n) {
    const o = this.o
    if (o + n > this.buf.length) throw new RangeError('fin du tampon')
    this.o += n
    return o
  }

  u8() { return this.buf[this.avancer(1)] }
  u16() { return this.buf.readUInt16LE(this.avancer(2)) }
  u32() { return this.buf.readUInt32LE(this.avancer(4)) }
  // Les montants de ce protocole restent sous 2^53 (offre de 10^15 unités) :
  // le passage en Number ne perd rien de ce qu'on utilise.
  u64() { return Number(this.buf.readBigUInt64LE(this.avancer(8))) }
  i64() { return Number(this.buf.readBigInt64LE(this.avancer(8))) }
  x128(signe) {
    const o = this.avancer(16)
    const bas = this.buf.readBigUInt64LE(o), haut = this.buf.readBigUInt64LE(o + 8)
    let v = (haut << 64n) | bas
    if (signe && haut >> 63n) v -= 1n << 128n
    return Number(v)
  }
  pubkey() { return base58(this.buf.subarray(this.avancer(32), this.o)) }
  chaine() {
    const n = this.u32()
    return this.buf.subarray(this.avancer(n), this.o).toString('utf8')
  }
}

function lire(r, type, types) {
  if (typeof type === 'string') {
    switch (type) {
      case 'bool': return r.u8() === 1
      case 'u8': return r.u8()
      case 'u16': return r.u16()
      case 'u32': return r.u32()
      case 'u64': return r.u64()
      case 'i64': return r.i64()
      case 'u128': return r.x128(false)
      case 'i128': return r.x128(true)
      case 'pubkey': return r.pubkey()
      case 'string': return r.chaine()
      default: throw new Error(`type IDL non géré : ${type}`)
    }
  }
  if (type.vec) {
    const n = r.u32()
    // Une longueur absurde signale un désalignement, pas une vraie liste.
    if (n > 10_000) throw new RangeError(`liste de ${n} éléments`)
    return Array.from({ length: n }, () => lire(r, type.vec, types))
  }
  if (type.option) return r.u8() ? lire(r, type.option, types) : null
  if (type.array) {
    const [t, n] = type.array
    return Array.from({ length: n }, () => lire(r, t, types))
  }
  if (type.defined) {
    const nom = type.defined.name ?? type.defined
    const def = types[nom]
    if (!def) throw new Error(`type IDL inconnu : ${nom}`)
    if (def.kind === 'struct') {
      const champs = def.fields ?? []
      // Tuple : champs anonymes (`["bool"]`) ; sinon champs nommés.
      if (champs.length && typeof champs[0] === 'string') return champs.map(t => lire(r, t, types))
      return Object.fromEntries(champs.map(c => [c.name, lire(r, c.type, types)]))
    }
    if (def.kind === 'enum') {
      const i = r.u8()
      const v = def.variants[i]
      if (!v) throw new RangeError(`variante ${i} absente de ${nom}`)
      if (v.fields?.length) throw new Error(`variante à données non gérée : ${nom}.${v.name}`)
      return v.name
    }
  }
  throw new Error(`type IDL non géré : ${JSON.stringify(type)}`)
}

/** Décode une suite de champs, jusqu'à la fin du tampon si besoin. */
function lireChamps(r, champs, types) {
  const out = {}
  for (const c of champs) {
    try {
      out[c.name] = lire(r, c.type, types)
    } catch (e) {
      if (e instanceof RangeError) { out._tronque = true; break }
      throw e
    }
  }
  return out
}

// --- index des discriminants -----------------------------------------------------

const PAR_DISCRIMINANT = new Map()
for (const [programme, p] of Object.entries(IDL.programs)) {
  for (const [nom, e] of Object.entries(p.events)) {
    PAR_DISCRIMINANT.set(Buffer.from(e.discriminator).toString('hex'),
      { programme, nom, champs: e.fields, types: p.types })
  }
}

/**
 * Décode une charge `Program data`. Renvoie `null` pour un événement qu'on
 * n'écoute pas — les programmes en émettent une vingtaine d'autres.
 */
export function decoderEvenement(b64) {
  const buf = Buffer.from(b64, 'base64')
  if (buf.length < 8) return null
  const def = PAR_DISCRIMINANT.get(buf.subarray(0, 8).toString('hex'))
  if (!def) return null
  return { programme: def.programme, nom: def.nom, data: lireChamps(new Lecteur(buf, 8), def.champs, def.types) }
}

/** Programmes dont on accepte les événements. */
const NOS_PROGRAMMES = new Set([PUMP, PUMPSWAP])

/**
 * Tous les événements reconnus d'une transaction, dans l'ordre des journaux.
 *
 * ⚠️ Un discriminant Anchor est le hachage du SEUL NOM de l'événement :
 * `sha256("event:TradeEvent")`. N'importe quel autre programme Solana ayant un
 * événement nommé `TradeEvent` produit donc exactement le même préfixe de huit
 * octets. Or on s'abonne aux transactions qui MENTIONNENT pump.fun, ce qui
 * inclut celles des agrégateurs et des routeurs, où d'autres programmes
 * écrivent aussi des lignes `Program data:`.
 *
 * Sans attribution, on lisait ces événements étrangers avec la grammaire de
 * pump.fun. Résultat observé en production : des pseudo-mints qui ne sont pas
 * des mints, des capitalisations à 93 M et des liquidités à 263 milliards.
 *
 * On reconstruit donc la pile d'appels — `Program <id> invoke [n]` empile,
 * `success` ou `failed` dépile — et on ne décode que les lignes écrites
 * pendant que l'un de NOS programmes est au sommet.
 */
export function evenementsDesLogs(logs) {
  const out = []
  const pile = []

  for (const l of logs ?? []) {
    if (l.startsWith('Program ') && l.includes(' invoke [')) {
      pile.push(l.slice(8, l.indexOf(' invoke [')))
      continue
    }
    if (l.startsWith('Program ') && (l.endsWith(' success') || l.includes(' failed'))) {
      pile.pop()
      continue
    }
    if (!l.startsWith('Program data: ')) continue

    // L'émetteur est le programme au sommet de la pile : un `emit!` s'exécute
    // dans le programme en cours.
    if (!NOS_PROGRAMMES.has(pile[pile.length - 1])) continue

    try {
      const e = decoderEvenement(l.slice(14))
      if (e) out.push(e)
    } catch { /* charge illisible : on l'ignore, l'événement suivant compte */ }
  }
  return out
}

/** Compte `Pool` de PumpSwap : seul moyen de relier un pool à son mint. */
export function decoderPool(b64) {
  const def = IDL.programs.pump_amm.accounts.Pool
  const buf = Buffer.from(b64, 'base64')
  if (!buf.subarray(0, 8).equals(Buffer.from(def.discriminator))) return null
  const d = lireChamps(new Lecteur(buf, 8), def.fields, IDL.programs.pump_amm.types)
  return { mint: d.base_mint, quoteMint: d.quote_mint, coinCreator: d.coin_creator ?? null }
}

// --- normalisation ------------------------------------------------------------------

const cotation = mint => (mint && mint !== PUBKEY_NULLE ? mint : WSOL)
const decimalesQuote = mint => DECIMALES_QUOTE[mint] ?? null
const symboleQuote = mint => (mint === WSOL ? 'SOL' : mint === USDC ? 'USDC' : null)

/**
 * Ramène un événement décodé à la forme qu'utilise le collecteur.
 *
 * `pools` relie un pool PumpSwap à son mint : les événements AMM ne portent
 * que l'adresse du pool. Un pool inconnu produit `{ type: 'pool_inconnu' }`,
 * à charge pour l'appelant de le résoudre.
 *
 * Prix et montants sont exprimés dans la monnaie de cotation (SOL ou USDC) ;
 * la conversion en dollars appartient à l'appelant, qui connaît le cours.
 */
export function normaliser(evt, { pools = new Map() } = {}) {
  const d = evt.data

  if (evt.nom === 'TradeEvent') {
    const quote = cotation(d.quote_mint)
    const dec = decimalesQuote(quote)
    const tokens = d.token_amount / 10 ** DECIMALES_PUMP
    // Pour une cotation SOL, les champs historiques font foi ; les champs
    // `quote_*` n'existent que dans les versions récentes.
    const montant = quote === WSOL ? d.sol_amount / 1e9
      : dec !== null && d.quote_amount != null ? d.quote_amount / 10 ** dec : null
    const vQuote = quote === WSOL ? d.virtual_sol_reserves / 1e9
      : dec !== null && d.virtual_quote_reserves != null ? d.virtual_quote_reserves / 10 ** dec : null
    const vTok = d.virtual_token_reserves / 10 ** DECIMALES_PUMP
    return {
      type: 'trade', venue: 'courbe',
      mint: d.mint, wallet: d.user, cote: d.is_buy ? 'buy' : 'sell',
      tokens, montant, quote: symboleQuote(quote),
      // Réserves virtuelles APRÈS le trade : le prix au comptant qui en découle
      // est celui que verra le trade suivant.
      prix: vQuote !== null && vTok > 0 ? vQuote / vTok : null,
      // Réserves RÉELLES, à ne pas confondre avec les virtuelles ci-dessus :
      // les virtuelles font le prix, les réelles font la liquidité — ce qu'on
      // pourrait effectivement sortir du pool. Elles remplacent la liquidité
      // que Mobula facturait au franchissement.
      reserveQuote: quote === WSOL ? d.real_sol_reserves / 1e9 : null,
      reserveBase: d.real_token_reserves != null ? d.real_token_reserves / 10 ** DECIMALES_PUMP : null,
      ts: d.timestamp * 1000,
      creator: d.creator ?? null,
      ix: d.ix_name ?? null
    }
  }

  if (evt.nom === 'CreateEvent') {
    return {
      type: 'create',
      mint: d.mint, name: d.name, symbol: d.symbol, uri: d.uri,
      curve: d.bonding_curve, creator: d.creator ?? d.user, ts: d.timestamp * 1000,
      supply: d.token_total_supply != null ? d.token_total_supply / 10 ** DECIMALES_PUMP : null,
      quote: symboleQuote(cotation(d.quote_mint))
    }
  }

  if (evt.nom === 'CompleteEvent') {
    return { type: 'complete', mint: d.mint, curve: d.bonding_curve, ts: d.timestamp * 1000 }
  }

  if (evt.nom === 'CreatePoolEvent') {
    return {
      type: 'pool', pool: d.pool, mint: d.base_mint, quoteMint: d.quote_mint,
      baseDec: d.base_mint_decimals, quoteDec: d.quote_mint_decimals,
      coinCreator: d.coin_creator ?? null, ts: d.timestamp * 1000
    }
  }

  if (evt.nom === 'BuyEvent' || evt.nom === 'SellEvent') {
    const p = pools.get(d.pool)
    if (!p) return { type: 'pool_inconnu', pool: d.pool, coinCreator: d.coin_creator ?? null }

    // Pool INVERSÉ : le SOL (ou l'USDC) y est le token de base, donc ce pool
    // cote autre chose que ce qu'on suit. Mesuré : 80 de nos 236 pools
    // enregistrés sont dans ce cas. Les lire à l'endroit donnait des prix à
    // 180 000 $ le token, et gonflait le compteur de cotations inconnues.
    if (p.mint === WSOL || p.mint === USDC) return { type: 'pool_inverse', pool: d.pool }

    const achat = evt.nom === 'BuyEvent'
    const baseDec = p.baseDec ?? DECIMALES_PUMP
    const quoteDec = p.quoteDec ?? decimalesQuote(p.quoteMint)
    if (quoteDec === null || quoteDec === undefined) return { type: 'cotation_inconnue', pool: d.pool, mint: p.mint }

    const tokens = (achat ? d.base_amount_out : d.base_amount_in) / 10 ** baseDec
    const montant = (achat ? d.quote_amount_in : d.quote_amount_out) / 10 ** quoteDec
    return {
      type: 'trade', venue: 'amm', pool: d.pool,
      mint: p.mint, wallet: d.user, cote: achat ? 'buy' : 'sell',
      tokens, montant, quote: symboleQuote(p.quoteMint),
      prix: prixAmm(d, achat, baseDec, quoteDec, tokens, montant),
      // Réserves du pool APRÈS le trade : celles de l'événement sont d'avant
      // (vérifié sur journaux réels), on lui applique donc l'échange.
      reserveQuote: d.pool_quote_token_reserves / 10 ** quoteDec + (achat ? montant : -montant),
      reserveBase: d.pool_base_token_reserves / 10 ** baseDec + (achat ? -tokens : tokens),
      ts: d.timestamp * 1000,
      creator: d.coin_creator ?? null,
      offre: d.base_supply != null ? d.base_supply / 10 ** baseDec : null
    }
  }

  return null
}

/**
 * Prix au comptant d'un pool PumpSwap APRÈS le trade.
 *
 * Les réserves de `BuyEvent`/`SellEvent` sont celles d'AVANT l'échange
 * (vérifié sur des logs réels : voir src/scripts/p10-check.js). On leur
 * applique donc le trade pour obtenir le prix que verra l'acheteur suivant,
 * comme pour la courbe, dont les réserves sont déjà postérieures.
 */
function prixAmm(d, achat, baseDec, quoteDec, tokens, montant) {
  const base = d.pool_base_token_reserves / 10 ** baseDec
  const quote = d.pool_quote_token_reserves / 10 ** quoteDec
  if (!(base > 0) || !(quote > 0)) return tokens > 0 ? montant / tokens : null
  const baseApres = achat ? base - tokens : base + tokens
  const quoteApres = achat ? quote + montant : quote - montant
  return baseApres > 0 && quoteApres > 0 ? quoteApres / baseApres : quote / base
}
