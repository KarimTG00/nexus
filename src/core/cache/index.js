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

class MemoryCache {
  constructor() { this.store = new Map(); this.shared = false }

  async get(k) {
    const e = this.store.get(k)
    if (!e) return null
    if (e.exp && e.exp < Date.now()) { this.store.delete(k); return null }
    return e.v
  }

  async set(k, v, ttlSec) {
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
  async quit() { this.store.clear() }
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

export async function connect() {
  if (impl) return impl

  if (!process.env.REDIS_URL) {
    impl = new MemoryCache()
    log.warn('REDIS_URL absent — repli mémoire (non partagé entre processus)')
    return impl
  }

  const { default: Redis } = await import('ioredis')
  const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true })
  await client.connect()
  impl = new RedisCache(client)
  log.info('Redis connecté')
  return impl
}

export function cache() {
  if (!impl) throw new Error('Cache non initialisé — appeler connect() d\'abord')
  return impl
}

export async function close() { if (impl) { await impl.quit(); impl = null } }
