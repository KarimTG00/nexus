/**
 * Rate limiter partagé — worker-pipeline et worker-collector puisent dans
 * les mêmes quotas. Sans partage, ils se marchent dessus et déclenchent des 429.
 *
 * Trois garde-fous :
 *   1. intervalle minimum entre deux appels (anti-rafale)
 *   2. concurrence maximale
 *   3. compteur de crédits journalier
 *
 * QUOTA MOBULA — l'en-tête `x-ratelimit-limit` annonce 10 000 mais ne
 * décrémente jamais : il ne reflète PAS le quota réel. Les quotas sont
 * MENSUELS et fixés par le plan souscrit :
 *
 *     gratuit      1 000 / mois  (~33/jour  — inexploitable en continu)
 *     Démarrer   125 000 / mois  (~4 166/jour)
 *     Croissance 1 250 000 / mois
 *
 * On compte donc nous-mêmes, sur une base journalière dérivée du plan.
 * `sources.daily_budget` doit rester cohérent avec `sources.plan`.
 */

import { cache } from '../cache/index.js'
import { mod } from '../logger.js'

const log = mod('rate')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const today = () => new Date().toISOString().slice(0, 10)

export class RateLimiter {
  /**
   * @param {string} name        identifiant du quota (ex. 'mobula')
   * @param {Object} opts
   * @param {number} opts.dailyBudget   crédits/jour avant refus
   * @param {number} opts.minIntervalMs intervalle minimum entre appels
   * @param {number} opts.concurrency   appels simultanés max
   * @param {number} opts.warnAt        seuil d'avertissement (0-1)
   */
  constructor(name, { dailyBudget = 3800, minIntervalMs = 150, concurrency = 2, warnAt = 0.8,
                      maxIntervalMs = 5000 } = {}) {
    this.name = name
    this.dailyBudget = dailyBudget
    this.baseIntervalMs = minIntervalMs
    this.minIntervalMs = minIntervalMs      // valeur courante, adaptative
    this.maxIntervalMs = maxIntervalMs
    this.concurrency = concurrency
    this.warnAt = warnAt

    this.lastCallAt = 0
    this.inFlight = 0
    this.warned = false
    this.exhaustedLogged = false

    // Compteurs exposés — le script de validation doit pouvoir les lire
    this.calls = 0
    this.errors = 0
    this.rateLimited = 0
    this.okStreak = 0
  }

  /**
   * Un 429 est arrivé : on double l'intervalle, plafonné.
   * Mesuré au POC : Mobula tient 600 req/min en séquentiel, mais throttle
   * par à-coups. L'adaptation vaut mieux qu'une constante devinée.
   */
  penalize() {
    this.rateLimited++
    this.okStreak = 0
    const next = Math.min(this.minIntervalMs * 2, this.maxIntervalMs)
    if (next !== this.minIntervalMs) {
      this.minIntervalMs = next
      log.warn({ source: this.name, intervalMs: next }, 'throttling — intervalle augmenté')
    }
  }

  /** Succès durable : on redescend progressivement vers l'intervalle de base. */
  reward() {
    this.okStreak++
    if (this.okStreak >= 20 && this.minIntervalMs > this.baseIntervalMs) {
      this.minIntervalMs = Math.max(this.baseIntervalMs, Math.round(this.minIntervalMs * 0.7))
      this.okStreak = 0
      log.debug({ source: this.name, intervalMs: this.minIntervalMs }, 'intervalle détendu')
    }
  }

  get quotaKey() { return `quota:${this.name}:${today()}` }

  /** Crédits consommés aujourd'hui. */
  async used() {
    return Number(await cache().get(this.quotaKey)) || 0
  }

  async remaining() {
    return Math.max(0, this.dailyBudget - await this.used())
  }

  /**
   * Réserve `cost` crédits et attend que les garde-fous soient satisfaits.
   * Lève si le budget journalier est épuisé.
   */
  async acquire(cost = 1) {
    const used = await this.used()

    if (used + cost > this.dailyBudget) {
      if (!this.exhaustedLogged) {
        this.exhaustedLogged = true
        log.error({ source: this.name, used, budget: this.dailyBudget },
          'BUDGET QUOTIDIEN ÉPUISÉ — plus aucun appel jusqu\'à minuit UTC. '
          + 'La découverte étant interrompue, les tokens lancés pendant ce temps '
          + 'sortiront de la fenêtre Pulse (~3 h) et seront définitivement perdus.')
      }
      throw new QuotaExceededError(
        `Budget ${this.name} épuisé : ${used}/${this.dailyBudget} crédits aujourd'hui`)
    }

    if (!this.warned && used / this.dailyBudget >= this.warnAt) {
      this.warned = true
      log.warn({ source: this.name, used, budget: this.dailyBudget },
        'budget journalier bientôt atteint')
    }

    // Concurrence
    while (this.inFlight >= this.concurrency) await sleep(25)

    // Intervalle minimum
    const wait = this.minIntervalMs - (Date.now() - this.lastCallAt)
    if (wait > 0) await sleep(wait)

    this.lastCallAt = Date.now()
    this.inFlight++

    const c = cache()
    const total = await c.incr(this.quotaKey)
    if (cost > 1) for (let i = 1; i < cost; i++) await c.incr(this.quotaKey)
    if (total === 1) await c.expire(this.quotaKey, 2 * 86400)

    return () => { this.inFlight-- }
  }

  /**
   * Enveloppe une fonction asynchrone avec la réservation de quota.
   * Adapte l'intervalle selon le résultat, et compte les échecs.
   */
  async run(fn, cost = 1) {
    const release = await this.acquire(cost)
    this.calls++
    try {
      const r = await fn()
      this.reward()
      return r
    } catch (e) {
      this.errors++
      if (e?.status === 429 || /\b429\b/.test(e?.message ?? '')) this.penalize()
      throw e
    } finally {
      release()
    }
  }

  async stats() {
    const used = await this.used()
    return {
      source: this.name,
      used,
      budget: this.dailyBudget,
      remaining: this.dailyBudget - used,
      pct: Math.round(used / this.dailyBudget * 100),
      calls: this.calls,
      errors: this.errors,
      rateLimited: this.rateLimited,
      intervalMs: this.minIntervalMs
    }
  }
}

export class QuotaExceededError extends Error {
  constructor(msg) { super(msg); this.name = 'QuotaExceededError' }
}
