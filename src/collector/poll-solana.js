/**
 * Collecte des swaps Solana par SONDAGE RPC.
 *
 * Remplace le webhook Helius, dont le modèle facturait chaque swap livré :
 * 745 890 événements par jour, un million de crédits épuisés en vingt-quatre
 * heures, dont 88 % pour des tokens que le pipeline avait déjà écartés.
 *
 * Alchemy n'implémente aucun abonnement Solana — vérifié, `slotSubscribe`
 * compris — donc pas de WebSocket ici. On sonde, et le coût devient prévisible
 * parce qu'il dépend de la CADENCE et du NOMBRE DE TOKENS, deux grandeurs
 * qu'on choisit, au lieu du volume de swaps, qu'on subit.
 *
 * Deux mécanismes mesurés avant d'être utilisés :
 *   `until`   ne renvoie que les signatures postérieures à la dernière vue.
 *             Sans lui, chaque sondage relirait tout l'historique.
 *   lot JSON-RPC  plusieurs appels dans une seule requête HTTP. Cinq
 *             `getTransaction` groupés répondent en 1,4 s.
 *
 * Budget observé, périmètre `tracked` + `alerted` (432 tokens) :
 *   toutes les 5 min → 124 416 appels/jour
 *   toutes les 2 min → 311 040
 * plus un `getTransaction` par swap réellement nouveau.
 */

import { request } from '../core/net/http.js'
import { col } from '../core/db/client.js'
import { fournisseur } from '../adapters/rpc/providers.js'
import { statutsSurveilles } from './scope.js'
import { parseBatchRpc } from './parse-rpc.js'
import { enqueue } from './ingest.js'
import { mod } from '../core/logger.js'

const log = mod('collector:poll')

/**
 * Taille des lots et rythme.
 *
 * Un lot JSON-RPC économise des requêtes HTTP mais pas des appels : le
 * fournisseur en compte vingt quand on en groupe vingt, et les reçoit tous
 * dans la même milliseconde. Premier essai à 20 sans temporisation : 34 échecs
 * 429 sur 169 appels, et seulement 6 tokens sur 40 ancrés.
 *
 * On réduit donc la taille du lot et on espace les envois. Le débit visé
 * n'est pas le maximum possible, c'est celui qui ne perd rien.
 */
const LOT_SIGNATURES = 5     // tokens par requête HTTP
const LOT_TRANSACTIONS = 5   // transactions par requête HTTP

const pause = ms => new Promise(r => setTimeout(r, ms))

/**
 * Temporisation ADAPTATIVE.
 *
 * Une pause fixe ne peut pas convenir : ce qu'impose le fournisseur est un
 * débit, il varie avec l'offre et avec la charge du moment. Mesuré à 300 ms
 * fixes, 35 échecs 429 subsistaient sur 171 appels.
 *
 * On ralentit franchement à chaque refus et on accélère prudemment après une
 * série de succès — le débit trouvé est celui qui ne perd rien, pas le maximum
 * théorique. Un 429 n'est pas gratuit : la requête a été émise, comptée, et
 * son contenu est perdu.
 */
class Rythme {
  constructor({ min = 120, max = 5000, depart = 300 } = {}) {
    this.min = min; this.max = max; this.ms = depart
    this.succes = 0; this.refus = 0
  }

  async attendre() { await pause(this.ms) }

  echec() {
    this.refus++
    this.succes = 0
    this.ms = Math.min(this.max, Math.round(this.ms * 1.8))
  }

  reussite() {
    this.succes++
    // Trois succès d'affilée avant d'accélérer : on ne veut pas osciller
    // autour du plafond, chaque dépassement coûtant une requête perdue.
    if (this.succes >= 3) {
      this.succes = 0
      this.ms = Math.max(this.min, Math.round(this.ms * 0.85))
    }
  }
}

/**
 * Envoie un lot, puis REJOUE les sous-appels refusés pour dépassement de débit.
 *
 * Alchemy répond HTTP 200 en plaçant un `code: 429` dans chaque sous-réponse
 * qu'il n'a pas pu servir — « exceeded its compute units per second capacity ».
 * Un lot de dix arrive dans la même milliseconde ; mesuré, la moitié passe.
 *
 * Ces refus sont donc invisibles au niveau HTTP : le client de `http.js`
 * réessaie les 429 d'en-tête, pas ceux-là. Sans reprise ici, un swap sur deux
 * était simplement perdu, sans erreur apparente — et `positions` se serait
 * remplie de trous qu'aucun relevé ultérieur n'aurait comblés.
 */
const estDebordement = r => r?.error?.code === 429

async function lotAvecReprise(url, appels, rythme, tentatives = 3) {
  const final = new Array(appels.length)
  let restants = appels.map((a, i) => ({ a, i }))

  for (let essai = 1; essai <= tentatives && restants.length; essai++) {
    const reponses = await lotRpc(url, restants.map(x => x.a))

    const encore = []
    restants.forEach((x, k) => {
      const r = reponses[k]
      if (estDebordement(r)) encore.push(x)
      else final[x.i] = r
    })

    if (!encore.length) { rythme.reussite(); break }

    rythme.echec()
    restants = encore
    if (essai < tentatives) await rythme.attendre()
  }

  // Ce qui reste après les tentatives est un manque assumé, pas un succès :
  // on renvoie l'erreur telle quelle pour qu'elle soit comptée.
  for (const x of restants) final[x.i] ??= { error: { code: 429, message: 'debit depasse' } }
  return final
}

/** Envoie un lot JSON-RPC et renvoie les réponses dans l'ordre des identifiants. */
async function lotRpc(url, appels) {
  if (!appels.length) return []
  const { json } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(appels.map((a, i) => ({ jsonrpc: '2.0', id: i, ...a })))
  })
  if (!Array.isArray(json)) {
    // Un lot peut être refusé en bloc (quota, taille) : on le signale plutôt
    // que de rendre un tableau vide qu'on prendrait pour « aucun swap ».
    throw new Error(json?.error?.message ?? 'réponse de lot inattendue')
  }
  const out = new Array(appels.length)
  for (const r of json) out[r.id] = r
  return out
}

/**
 * Tokens à sonder, les plus anciennement vus en premier.
 * L'ordre par `swap_polled_at` garantit qu'aucun token n'est délaissé quand
 * le budget ne permet pas de tous les couvrir.
 */
export async function aSonder(cfg, limite) {
  return col('tokens').find(
    // Un token du flux temps réel a déjà chacun de ses trades : le sonder
    // paierait des appels pour relire ce qu'on a reçu gratuitement.
    { chain: 'solana', status: { $in: statutsSurveilles(cfg, 'solana') }, 'live.source': { $ne: 'stream' } },
    { projection: { address: 1, symbol: 1, swap_last_sig: 1, swap_polled_at: 1 } }
  ).sort({ swap_polled_at: 1 }).limit(limite).toArray()
}

/**
 * Un passage de collecte.
 * @returns {Object} statistiques du passage
 */
export async function pollSwaps(cfg) {
  const stats = { tokens: 0, appels: 0, signatures: 0, transactions: 0, swaps: 0, erreurs: 0 }

  if (!cfg?.features?.swap_collector?.enabled) {
    return { ...stats, skipped: true, reason: 'collecteur desactive' }
  }

  const f = fournisseur(cfg?.sources?.rpc_provider ?? null)
  if (!f) return { ...stats, skipped: true, reason: 'aucun fournisseur RPC configure' }

  const seuils = cfg.thresholds?.collector ?? {}
  const budget = seuils.poll_tokens_par_passage ?? 200
  const maxSig = seuils.poll_max_signatures ?? 100

  const rythme = new Rythme({ depart: seuils.poll_pause_ms ?? 300 })

  const tokens = await aSonder(cfg, budget)
  if (!tokens.length) return { ...stats, skipped: true, reason: 'aucun token a sonder' }
  stats.tokens = tokens.length

  // --- étape 1 : quelles signatures sont nouvelles ? ------------------------
  const nouvelles = []            // { token, signature }
  const majPoll = []

  for (let i = 0; i < tokens.length; i += LOT_SIGNATURES) {
    const tranche = tokens.slice(i, i + LOT_SIGNATURES)
    const appels = tranche.map(t => ({
      method: 'getSignaturesForAddress',
      params: [t.address, t.swap_last_sig
        ? { until: t.swap_last_sig, limit: maxSig }
        : { limit: Math.min(maxSig, 25) }]   // premier passage : on ne remonte pas loin
    }))

    let reponses
    try {
      reponses = await lotAvecReprise(f.httpUrl, appels, rythme)
      stats.appels += appels.length
    } catch (e) {
      stats.erreurs++
      rythme.echec()
      log.warn({ err: e.message, tranche: tranche.length, pause: rythme.ms },
        'lot de signatures en echec')
      // Sans cette ligne, un lot en echec laisse ses tokens avec le
      // `swap_polled_at` le plus ancien : le tri les resert au passage
      // suivant, indefiniment, et les autres ne sont jamais sondes.
      for (const t of tranche) {
        majPoll.push({ updateOne: { filter: { _id: t._id },
          update: { $set: { swap_polled_at: new Date() } } } })
      }
      await rythme.attendre()
      continue
    }
    await rythme.attendre()

    tranche.forEach((t, k) => {
      const r = reponses[k]
      if (!r || r.error) { stats.erreurs++; return }
      const liste = (r.result ?? []).filter(s => !s.err)

      // La plus récente devient l'ancre du prochain passage, même si aucune
      // transaction n'est exploitable — sinon on la relirait indéfiniment.
      const ancre = r.result?.[0]?.signature ?? t.swap_last_sig ?? null
      majPoll.push({ updateOne: { filter: { _id: t._id }, update: { $set: {
        swap_polled_at: new Date(), ...(ancre ? { swap_last_sig: ancre } : {})
      } } } })

      for (const s of liste) nouvelles.push({ token: t, signature: s.signature })
    })
  }

  stats.signatures = nouvelles.length
  if (majPoll.length) await col('tokens').bulkWrite(majPoll, { ordered: false })
  if (!nouvelles.length) return stats

  // --- étape 2 : récupérer et analyser les transactions ---------------------
  const mints = new Set(tokens.map(t => t.address))

  for (let i = 0; i < nouvelles.length; i += LOT_TRANSACTIONS) {
    const tranche = nouvelles.slice(i, i + LOT_TRANSACTIONS)
    const appels = tranche.map(n => ({
      method: 'getTransaction',
      params: [n.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    }))

    let reponses
    try {
      reponses = await lotAvecReprise(f.httpUrl, appels, rythme)
      stats.appels += appels.length
    } catch (e) {
      stats.erreurs++
      rythme.echec()
      log.warn({ err: e.message, pause: rythme.ms }, 'lot de transactions en echec')
      await rythme.attendre()
      continue
    }
    await rythme.attendre()

    const brutes = []
    for (const r of reponses) {
      if (!r || r.error || !r.result) continue
      stats.transactions++
      brutes.push(r.result)
    }

    if (brutes.length) {
      // On passe par la file d'ingestion, comme le webhook : déduplication,
      // écritures groupées et journal agrégé y sont déjà. Le parsing se fait
      // une seule fois, dans `ingest`, d'où le format explicite.
      stats.swaps += parseBatchRpc(brutes, mints).length
      enqueue(brutes, { format: 'rpc' })
    }
  }

  return { ...stats, pause_finale_ms: rythme.ms, refus: rythme.refus }
}
