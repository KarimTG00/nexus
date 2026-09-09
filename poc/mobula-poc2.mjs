/**
 * POC Mobula — passe 2 : élucide les 3 zones grises de la passe 1.
 *   A. Pulse renvoie 0 entrée → mauvais paramètre ?
 *   B. Holders → 404, quel est le bon chemin ?
 *   C. Taille max d'un lot + latence réelle en parallèle (le point le plus inquiétant)
 *
 * Usage : node --env-file=.env poc/mobula-poc2.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const KEY = process.env.MOBULA_KEY
const BASE = 'https://api.mobula.io'
const out = {}

async function call(path, { method = 'GET', body = null } = {}) {
  const url = path.startsWith('http') ? path : BASE + path
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    const ms = Date.now() - t0
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { ok: res.ok, status: res.status, ms, json, text: text.slice(0, 400) }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e) }
  }
}

const count = j => {
  const d = j?.data ?? j?.result ?? j
  if (Array.isArray(d)) return d.length
  if (d && typeof d === 'object') return Object.keys(d).length
  return 0
}

// --- A. Pulse : trouver la bonne combinaison de paramètres ----------------
async function findPulse() {
  console.log('\n=== A. Pulse — recherche des bons paramètres ===')
  const variants = [
    '/api/2/pulse?limit=10',
    '/api/2/pulse?limit=10&chainId=solana:solana',
    '/api/2/pulse?limit=10&chainId=solana',
    '/api/2/pulse?limit=10&assetMode=true',
    '/api/2/pulse?limit=10&chainId=evm:8453',
    '/api/2/pulse?limit=10&pagination=true',
    '/api/1/pulse?limit=10'
  ]
  const results = []
  for (const v of variants) {
    const r = await call(v)
    const n = count(r.json)
    console.log(`  ${String(r.status).padEnd(4)} n=${String(n).padEnd(4)} ${r.ms}ms  ${v}`)
    if (!r.ok || n === 0) console.log(`        ↳ ${r.text?.slice(0, 160)}`)
    results.push({ variant: v, status: r.status, n, ms: r.ms, sample: n ? r.json : r.text })
    await new Promise(s => setTimeout(s, 200))
  }
  const win = results.find(r => r.n > 0)
  out.pulse = { results, winner: win?.variant ?? null }
  if (win) {
    console.log(`\n  → variante retenue : ${win.variant}`)
    const d = win.sample?.data ?? win.sample?.result ?? win.sample
    const first = Array.isArray(d) ? d[0] : Object.values(d)[0]
    out.pulseKeys = Object.keys(first ?? {})
    console.log('  → champs de premier niveau :', out.pulseKeys.slice(0, 25).join(', '))
  } else {
    console.log('\n  → aucune variante ne renvoie de données')
  }
}

// --- B. Holders : trouver le bon chemin -----------------------------------
async function findHolders() {
  console.log('\n=== B. Holders — recherche du bon chemin ===')
  const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const paths = [
    `/api/1/market/token-holder-positions?blockchain=solana&address=${A}&limit=5`,
    `/api/2/token/holder-positions?blockchain=solana&address=${A}&limit=5`,
    `/api/2/token/holders?blockchain=solana&address=${A}&limit=5`,
    `/api/1/market/token-holders?blockchain=solana&address=${A}&limit=5`,
    `/api/2/token/trader-positions?blockchain=solana&address=${A}&limit=5`,
    `/api/1/market/data?asset=${A}&blockchain=solana`  // le champ holders y est-il ?
  ]
  const results = []
  for (const p of paths) {
    const r = await call(p)
    const n = count(r.json)
    const hasHolders = /holder/i.test(JSON.stringify(r.json ?? {}).slice(0, 4000))
    console.log(`  ${String(r.status).padEnd(4)} n=${String(n).padEnd(4)} holders:${hasHolders ? 'oui' : 'non'}  ${p.split('?')[0]}`)
    results.push({ path: p.split('?')[0], status: r.status, n, hasHolders })
    await new Promise(s => setTimeout(s, 200))
  }
  out.holders = results
}

// --- C. Taille de lot + latence en parallèle ------------------------------
const POOL = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  'RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a'
]

async function batchLimits() {
  console.log('\n=== C1. Taille maximale d\'un lot ===')
  const results = []
  for (const n of [3, 5, 10]) {
    const assets = POOL.slice(0, n).join(',')
    const r = await call('/api/1/market/multi-data?assets=' + encodeURIComponent(assets))
    const got = count(r.json)
    console.log(`  demandé ${String(n).padEnd(3)} → reçu ${String(got).padEnd(3)}  ${r.status}  ${r.ms}ms`)
    results.push({ asked: n, got, status: r.status, ms: r.ms })
    await new Promise(s => setTimeout(s, 300))
  }
  // Duplication pour tester une charge plus lourde sans adresses supplémentaires
  const big = [...POOL, ...POOL, ...POOL, ...POOL, ...POOL].slice(0, 50).join(',')
  const rb = await call('/api/1/market/multi-data?assets=' + encodeURIComponent(big))
  console.log(`  50 entrées (10 uniques) → reçu ${count(rb.json)}  ${rb.status}  ${rb.ms}ms`)
  results.push({ asked: 50, got: count(rb.json), status: rb.status, ms: rb.ms })
  out.batch = results
}

async function latency() {
  console.log('\n=== C2. Latence — séquentiel vs parallèle ===')
  const url = `/api/1/market/data?asset=${POOL[0]}&blockchain=solana`

  const t1 = Date.now()
  for (let i = 0; i < 5; i++) await call(url)
  const seq = Date.now() - t1

  const t2 = Date.now()
  await Promise.all(Array.from({ length: 5 }, () => call(url)))
  const par = Date.now() - t2

  console.log(`  5 appels séquentiels : ${seq} ms  (${Math.round(seq / 5)} ms/appel)`)
  console.log(`  5 appels parallèles  : ${par} ms  (${Math.round(par / 5)} ms/appel effectif)`)
  console.log(`  gain du parallélisme : ×${(seq / par).toFixed(1)}`)
  out.latency = { seq, par, gain: +(seq / par).toFixed(1) }
}

async function quota() {
  console.log('\n=== C3. Décompte du quota ===')
  const before = await call('/api/1/system-metadata')
  for (let i = 0; i < 3; i++) await call(`/api/1/market/data?asset=${POOL[0]}&blockchain=solana`)
  const after = await call('/api/1/system-metadata')
  const g = r => r.json ? null : null
  console.log('  (les en-têtes de quota sont relevés dans la passe 1 : limit 10000, cost 1)')
  out.quotaNote = 'x-ratelimit-limit=10000, x-ratelimit-cost=1 par appel'
}

async function main() {
  console.log('POC Mobula — passe 2 —', new Date().toISOString())
  console.log('='.repeat(70))
  await findPulse()
  await findHolders()
  await batchLimits()
  await latency()
  await quota()

  mkdirSync('poc/out', { recursive: true })
  writeFileSync('poc/out/findings2.json', JSON.stringify(out, null, 2))
  console.log('\nDétail : poc/out/findings2.json')
}

main().catch(e => { console.error(e); process.exit(1) })
