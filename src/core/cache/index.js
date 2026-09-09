/**
 * Cache et verrous — Redis si REDIS_URL est défini, repli mémoire sinon.
 *
 * Le repli mémoire permet de développer sans Redis, mais il n'est PAS
 * utilisable en production multi-processus : le rate limiter et les verrous
 * doivent être partagés entre worker-pipeline et worker-collector.
 */

import { mod } from '../logger.js'

const log = mod('cache')

let impl = null

/**
 * Nombre maximal d'entrées du repli mémoire.
 *
 * Ce plafond n'est pas une précaution théorique : sans lui, le service web est
 * mort par épuisement mémoire. La déduplication des swaps écrit une clé
 * `swap:<signature>:<mint>:<side>` par swap, avec 24 h de TTL — et cette clé
 * n'est JAMAIS relue. Or l'expiration ici est paresseuse : elle ne se déclenche
 * qu'à la lecture de la clé concernée. Des centaines de milliers d'entrées par
 * jour s'accumulaient donc sans qu'aucune ne puisse jamais être libérée.
 */
const MAX_ENTREES = 50_000
const BALAYAGE_MS = 60_000

class MemoryCache {
  constructor() {
    this.store = new Map()
    this.shared = false
    this.evictions = 0
    this.dernierBalayage = 0
    this.dernierAvis = 0

    // Balayage périodique : récupère les entrées expirées que personne ne
    // relira. `unref` pour ne pas maintenir le process en vie à lui seul.
    this.balai = setInterval(() => this.balayer(), BALAYAGE_MS)
    this.balai.unref?.()
  }

  balayer() {
    const now = Date.now()
    this.dernierBalayage = now
    let libres = 0
    for (const [k, e] of this.store) {
      if (e.exp && e.exp < now) { this.store.delete(k); libres++ }
    }
    return libres
  }

  async get(k) {
    const e = this.store.get(k)
    if (!e) return null
    if (e.exp && e.exp < Date.now()) { this.store.delete(k); return null }
    return e.v
  }

  async set(k, v, ttlSec) {
    if (!this.store.has(k) && this.store.size >= MAX_ENTREES) {
      // Balayer d'abord : sous TTL court, cela suffit à faire de la place.
      //
      // Mais au plus une fois par seconde : un balayage parcourt les 50 000
      // entrées, et le relancer à chaque écriture rendrait le chemin chaud
      // quadratique — mesuré à 13 s pour 60 000 écritures avant ce garde-fou.
      const peutBalayer = Date.now() - this.dernierBalayage > 1000
      if (!peutBalayer || this.balayer() === 0) {
        // Sinon, éviction de la plus ancienne insérée — `Map` conserve l'ordre.
        //
        // Compromis assumé : évincer une clé de déduplication encore valide
        // peut faire recompter un swap, donc gonfler une position. C'est
        // regrettable, mais un OOM perd TOUT le flux pendant le redémarrage,
        // et fait perdre les webhooks qu'Helius pousse pendant ce temps.
        // Le vrai correctif est REDIS_URL, qui expire les clés de lui-même.
        const premiere = this.store.keys().next().value
        this.store.delete(premiere)
        // Avertir au plus une fois par minute : sous saturation soutenue, un
        // message par millier d'évictions noierait le reste des logs.
        this.evictions++
        if (Date.now() - this.dernierAvis > 60_000) {
          this.dernierAvis = Date.now()
          log.warn({ evictions: this.evictions, plafond: MAX_ENTREES },
            'repli mémoire saturé — définir REDIS_URL : des clés encore valides '
            + 'sont évincées, la déduplication devient approximative')
        }
      }
    }
    this.store.set(k, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : null })
    return 'OK'
  }

  async incr(k) {
    const cur = Number(await this.get(k)) || 0
    await this.set(k, String(cur + 1))
    return cur + 1
  }

  async expire(k, ttlSec) {
    const e = this.store.get(k)
    if (e) e.exp = Date.now() + ttlSec * 1000
    return 1
  }

  /** Verrou : renvoie true si acquis. */
  async lock(k, ttlSec = 30) {
    if (await this.get(`lock:${k}`)) return false
    await this.set(`lock:${k}`, '1', ttlSec)
    return true
  }

  async unlock(k) { this.store.delete(`lock:${k}`) }
  async ping() { return 'PONG (mémoire)' }
  async quit() { clearInterval(this.balai); this.store.clear() }
}

class RedisCache {
  constructor(client) { this.r = client; this.shared = true }
  get(k) { return this.r.get(k) }
  set(k, v, ttlSec) { return ttlSec ? this.r.set(k, v, 'EX', ttlSec) : this.r.set(k, v) }
  incr(k) { return this.r.incr(k) }
  expire(k, ttlSec) { return this.r.expire(k, ttlSec) }
  async lock(k, ttlSec = 30) { return (await this.r.set(`lock:${k}`, '1', 'EX', ttlSec, 'NX')) === 'OK' }
  unlock(k) { return this.r.del(`lock:${k}`) }
  ping() { return this.r.ping() }
  quit() { return this.r.quit() }
}

/**
 * Redis reste facultatif au démarrage, mais ce n'est plus une simple
 * optimisation depuis que le collecteur de swaps tourne. Il porte trois
 * choses : le limiteur de débit partagé, les verrous, et la déduplication des
 * swaps — cette dernière écrit une clé par swap avec 24 h de TTL. Le repli
 * mémoire n'expire qu'à la relecture, or ces clés ne sont jamais relues : sans
 * plafond, le service web mourait par épuisement mémoire. D'où MAX_ENTREES,
 * qui borne le dégât mais rend la déduplication approximative sous charge.
 *
 * Autrement dit : un seul worker sans collecteur fonctionne très bien sans
 * Redis ; le service web qui reçoit les webhooks Helius, non.
 *
 * On ne laisse donc JAMAIS son indisponibilité tuer le pipeline. Une URL
 * présente mais injoignable — service Railway pas encore prêt, mal relié,
 * ou en cours de redémarrage — faisait sortir le worker en code 1, et
 * l'orchestrateur le relançait en boucle. Chaque redémarrage coûte des
 * minutes de découverte, et la fenêtre Pulse ne remonte qu'à ~3 h.
 */
export async function connect({ timeoutMs = 10_000 } = {}) {
  if (impl) return impl

  if (!process.env.REDIS_URL) {
    impl = new MemoryCache()
    log.warn('REDIS_URL absent — repli mémoire (non partagé entre processus)')
    return impl
  }

  // Déclaré hors du `try` pour pouvoir être fermé depuis le `catch` : sans ça
  // le client continue de réessayer en arrière-plan après le repli, et peut
  // finir connecté alors que plus personne ne s'en sert.
  let client = null

  try {
    const { default: Redis } = await import('ioredis')
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      connectTimeout: timeoutMs,
      // Le réseau privé de Railway ne publie que des AAAA : `redis.railway
      // .internal` n'a pas d'adresse IPv4. `family: 0` laisse la résolution
      // accepter les deux familles ; forcer IPv4 échouerait silencieusement,
      // et l'échec se traduirait par un repli mémoire — donc le retour de la
      // fuite, sans que rien ne le signale clairement.
      family: 0,
      // Sans plafond, ioredis réessaie indéfiniment et émet des erreurs
      // non capturées qui feraient tomber le processus.
      retryStrategy: times => (times > 5 ? null : Math.min(times * 500, 3000))
    })

    // Un `error` non écouté sur un client ioredis est une exception fatale.
    client.on('error', e => log.warn({ err: e.message }, 'erreur Redis'))

    await Promise.race([
      client.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('délai de connexion dépassé')), timeoutMs))
    ])

    impl = new RedisCache(client)
    log.info('Redis connecté')
    return impl
  } catch (e) {
    try { client?.disconnect() } catch { /* déjà fermé */ }
    impl = new MemoryCache()
    log.warn({ err: e.message },
      'Redis injoignable — REPLI MÉMOIRE. Le pipeline continue, mais quotas et '
      + 'verrous ne sont plus partagés : à corriger avant de faire tourner '
      + 'plusieurs processus (worker + collecteur).')
    return impl
  }
}

export function cache() {
  if (!impl) throw new Error('Cache non initialisé — appeler connect() d\'abord')
  return impl
}

export async function close() { if (impl) { await impl.quit(); impl = null } }
