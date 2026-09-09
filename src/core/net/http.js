/**
 * Client HTTP avec réessais — back-off exponentiel sur 429, 5xx et erreurs réseau.
 * Respecte `Retry-After` quand le serveur le fournit.
 */

import { mod } from '../logger.js'

const log = mod('http')
const sleep = ms => new Promise(r => setTimeout(r, ms))

export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} sur ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * @param {string} url
 * @param {Object} opts  options fetch + { retries, baseDelayMs, timeoutMs }
 */
export async function request(url, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 500,
    timeoutMs = 30_000,
    ...fetchOpts
  } = opts

  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const t0 = Date.now()

    try {
      const res = await fetch(url, { ...fetchOpts, signal: ac.signal })
      clearTimeout(timer)
      const ms = Date.now() - t0

      const quota = {}
      for (const [k, v] of res.headers.entries()) {
        if (/ratelimit|retry-after/i.test(k)) quota[k] = v
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        if (RETRYABLE.has(res.status) && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : baseDelayMs * 2 ** attempt + Math.random() * 200
          log.warn({ url: redact(url), status: res.status, attempt: attempt + 1, delay: Math.round(delay) },
            'réessai')
          await sleep(delay)
          continue
        }
        throw new HttpError(res.status, body.slice(0, 500), redact(url))
      }

      const json = await res.json()
      return { json, ms, quota, status: res.status }

    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (e instanceof HttpError) throw e

      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt + Math.random() * 200
        log.warn({ url: redact(url), err: e.message, attempt: attempt + 1 }, 'erreur réseau, réessai')
        await sleep(delay)
        continue
      }
    }
  }

  throw lastErr ?? new Error(`Échec après ${retries + 1} tentatives : ${redact(url)}`)
}

/** Masque une éventuelle clé dans l'URL avant journalisation. */
function redact(url) {
  return String(url).replace(/([?&](api-key|key|apikey)=)[^&]+/gi, '$1[masqué]')
}
