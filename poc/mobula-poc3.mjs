/**
 * POC Mobula — passe 3 : les 3 dernières inconnues.
 *   A. Structure réelle de la réponse Pulse (champs exploitables pour l'admission)
 *   B. Plafond réel d'un lot — récolte d'adresses depuis Pulse puis montée en charge
 *   C. Le compte de holders est-il dans /market/data ? + période du quota
 *
 * Usage : node --env-file=.env poc/mobula-poc3.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const KEY = process.env.MOBULA_KEY
const BASE = 'https://api.mobula.io'
const out = {}

async function call(path, opts = {}) {
  const url = path.startsWith('http') ? path : BASE + path
  const t0 = Date.now()
  const res = await fetch(url, { headers: { Authorization: KEY }, ...opts })
  const ms = Date.now() - t0
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  const quota = {}
  for (const [k, v] of res.headers.entries()) {
    if (/rate|limit|remaining|credit|quota|retry/i.test(k)) quota[k] = v
  }
  return { ok: res.ok, status: res.status, ms, json, quota, text: text.slice(0, 300) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- A. Structure de Pulse -------------------------------------------------
async function pulseShape() {
  console.log('\n=== A. Structure réelle de Pulse ===')
  const r = await call('/api/2/pulse?limit=20&chainId=solana:solana')
  const d = r.json?.data

  console.log('  type de data :', Array.isArray(d) ? `tableau[${d.length}]` : typeof d)
  if (!Array.isArray(d) && d && typeof d === 'object') {
    console.log('  clés de data :', Object.keys(d).join(', '))
    for (const [k, v] of Object.entries(d)) {
      console.log(`    ${k} → ${Array.isArray(v) ? `tableau[${v.length}]` : typeof v}`)
    }
  }

  // Trouve le premier tableau d'objets, quel que soit le niveau
  let items = Array.isArray(d) ? d : null
  let bucket = 'data'
  if (!items && d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') { items = v; bucket = k; break }
    }
  }
  if (!items?.length) { console.log('  aucun tableau d\'objets trouvé'); out.pulse = { raw: r.json }; return [] }

  console.log(`\n  → ${items.length} entrées dans "${bucket}"`)
  const it = items[0]
  console.log('  → champs :', Object.keys(it).join(', '))

  // Champs qui nous intéressent pour l'admission (étage 1)
  const flat = JSON.stringify(it).toLowerCase()
  const checks = {
    'liquidité': /liquidity/, 'market cap': /marketcap|market_cap/,
    'volume': /volume/, 'achats/ventes': /buys|sells/,
    'création/âge': /createdat|created_at|listed/, 'sécurité': /honeypot|buytax|selltax/,
    'top10 holders': /top10/, 'dev holdings': /devholding/,
    'liste holders': /holders_list|holderslist/, 'bonding': /bonded|bondingpercentage/,
    'nb holders': /"holders"/
  }
  const have = Object.entries(checks).filter(([, re]) => re.test(flat)).map(([k]) => k)
  console.log('  → exploitables :', have.join(', ') || 'aucun')
  out.pulse = { bucket, count: items.length, fields: Object.keys(it), useful: have, sample: it }

  // Récolte d'adresses pour la passe B
  const addrs = items.map(i =>
    i.token0?.address ?? i.address ?? i.asset?.address ?? i.baseToken?.address
  ).filter(Boolean)
  console.log(`  → ${addrs.length} adresses récoltées pour le test de lot`)
  return [...new Set(addrs)]
}

// --- B. Plafond réel d'un lot ---------------------------------------------
async function batchCap(harvested) {
  console.log('\n=== B. Plafond réel d\'un lot ===')

  const known = [
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
  const pool = [...new Set([...known, ...harvested])]
  console.log(`  ${pool.length} adresses uniques disponibles`)

  const results = []
  for (const n of [10, 25, 50, 100].filter(n => n <= pool.length)) {
    const assets = pool.slice(0, n).join(',')
    const r = await call('/api/1/market/multi-data?assets=' + encodeURIComponent(assets))
    const got = r.json?.data ? Object.keys(r.json.data).length : 0
    const cost = r.quota['x-ratelimit-cost'] ?? '?'
    console.log(`  demandé ${String(n).padEnd(4)} → reçu ${String(got).padEnd(4)} coût ${String(cost).padEnd(4)} ${r.status} ${r.ms}ms`)
    results.push({ asked: n, got, cost, status: r.status, ms: r.ms })
    await sleep(400)
  }
  out.batch = { poolSize: pool.length, results }

  const best = results.filter(r => r.got === r.asked).at(-1)
  if (best) {
    console.log(`\n  → lot validé jusqu'à ${best.asked} tokens, coût ${best.cost} crédit(s)`)
    if (best.cost === '1') {
      console.log(`  → un lot de ${best.asked} coûte le même crédit qu'un appel simple`)
    }
  }
}

// --- C. Holders dans market/data ? + quota ---------------------------------
async function holdersAndQuota() {
  console.log('\n=== C. Compte de holders & quota ===')
  const A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' // BONK
  const r = await call(`/api/1/market/data?asset=${A}&blockchain=solana`)
  const d = r.json?.data ?? {}
  const holderKeys = Object.keys(d).filter(k => /holder/i.test(k))
  console.log('  champs de market/data :', Object.keys(d).join(', '))
  console.log('  → champs holders :', holderKeys.length ? holderKeys.map(k => `${k}=${d[k]}`).join(', ') : 'aucun')

  const hp = await call(`/api/2/token/holder-positions?blockchain=solana&address=${A}&limit=5`)
  const hd = hp.json?.data
  console.log(`  /api/2/token/holder-positions → ${hp.status}, ` +
    (Array.isArray(hd) ? `tableau[${hd.length}]` : `clés: ${Object.keys(hd ?? {}).join(', ')}`))
  if (hd && !Array.isArray(hd)) {
    const totKeys = Object.keys(hd).filter(k => /total|count/i.test(k))
    if (totKeys.length) console.log('  → total disponible :', totKeys.map(k => `${k}=${hd[k]}`).join(', '))
  }

  out.holders = {
    marketDataFields: Object.keys(d),
    holderKeysInMarketData: holderKeys.map(k => ({ k, v: d[k] })),
    holderPositionsStatus: hp.status,
    holderPositionsShape: Array.isArray(hd) ? `array[${hd.length}]` : Object.keys(hd ?? {})
  }

  console.log('\n  quota observé :', JSON.stringify(r.quota))
  out.quota = r.quota
}

async function main() {
  console.log('POC Mobula — passe 3 —', new Date().toISOString())
  console.log('='.repeat(70))
  const addrs = await pulseShape()
  await sleep(300)
  await batchCap(addrs)
  await sleep(300)
  await holdersAndQuota()

  mkdirSync('poc/out', { recursive: true })
  writeFileSync('poc/out/findings3.json', JSON.stringify(out, null, 2))
  console.log('\nDétail : poc/out/findings3.json')
}

main().catch(e => { console.error(e); process.exit(1) })
