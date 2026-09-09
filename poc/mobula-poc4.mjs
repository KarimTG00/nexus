/**
 * POC Mobula — passe 4 (finale) :
 *   A. Réponse brute de Pulse — pourquoi elle varie d'un appel à l'autre
 *   B. Plafond réel d'un lot, avec de vraies adresses récoltées sur DexScreener
 *
 * Usage : node --env-file=.env poc/mobula-poc4.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const KEY = process.env.MOBULA_KEY
const BASE = 'https://api.mobula.io'
const out = {}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function call(path) {
  const url = path.startsWith('http') ? path : BASE + path
  const t0 = Date.now()
  const res = await fetch(url, { headers: KEY ? { Authorization: KEY } : {} })
  const ms = Date.now() - t0
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  const quota = {}
  for (const [k, v] of res.headers.entries()) {
    if (/rate|limit|remaining|credit|quota/i.test(k)) quota[k] = v
  }
  return { ok: res.ok, status: res.status, ms, json, quota, text }
}

// --- A. Pulse brut, plusieurs fois -----------------------------------------
async function pulseRaw() {
  console.log('\n=== A. Pulse — réponse brute, 3 appels identiques ===')
  const url = '/api/2/pulse?limit=5&chainId=solana:solana'
  const shots = []
  for (let i = 0; i < 3; i++) {
    const r = await call(url)
    const preview = r.text.slice(0, 200).replace(/\s+/g, ' ')
    console.log(`  #${i + 1} ${r.status} ${r.ms}ms len=${r.text.length}`)
    console.log(`     ${preview}`)
    shots.push({ status: r.status, ms: r.ms, len: r.text.length, preview })
    await sleep(1500)
  }
  out.pulseShots = shots

  // Variantes de bucket documentées : new / bonding / bonded
  console.log('\n  --- avec poolTypes / views ---')
  for (const v of [
    '/api/2/pulse?limit=5&chainId=solana:solana&poolTypes=new',
    '/api/2/pulse?limit=5&chainId=solana:solana&poolTypes=bonding',
    '/api/2/pulse?limit=5&chainId=solana:solana&poolTypes=bonded',
    '/api/2/pulse?limit=5&chainId=solana:solana&compressed=false&excludeDuplicates=false'
  ]) {
    const r = await call(v)
    console.log(`  ${r.status} len=${String(r.text.length).padEnd(6)} ${v.split('&').slice(2).join('&')}`)
    if (r.text.length > 50) {
      console.log(`     ${r.text.slice(0, 220).replace(/\s+/g, ' ')}`)
    }
    await sleep(800)
  }
}

// --- B. Récolte d'adresses réelles puis plafond de lot ----------------------
async function harvest() {
  console.log('\n=== B1. Récolte d\'adresses réelles (DexScreener, gratuit) ===')
  const seen = new Set()
  for (const q of ['SOL', 'USDC', 'BONK', 'WIF', 'PEPE', 'DOGE', 'JUP', 'MEME']) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`)
      const j = await r.json()
      for (const p of (j.pairs ?? [])) {
        if (p.chainId === 'solana' && p.baseToken?.address) seen.add(p.baseToken.address)
      }
    } catch {}
    await sleep(300)
    if (seen.size > 220) break
  }
  const addrs = [...seen]
  console.log(`  ${addrs.length} adresses Solana uniques récoltées`)
  return addrs
}

async function batchCap(pool) {
  console.log('\n=== B2. Plafond réel d\'un lot ===')
  const results = []
  for (const n of [10, 25, 50, 100, 200].filter(n => n <= pool.length)) {
    const r = await call('/api/1/market/multi-data?assets=' +
      encodeURIComponent(pool.slice(0, n).join(',')))
    const got = r.json?.data ? Object.keys(r.json.data).length : 0
    const cost = r.quota['x-ratelimit-cost'] ?? '?'
    const rem = r.quota['x-ratelimit-remaining'] ?? '?'
    console.log(`  demandé ${String(n).padEnd(4)} → reçu ${String(got).padEnd(4)} coût ${String(cost).padEnd(4)} reste ${String(rem).padEnd(7)} ${r.status} ${r.ms}ms`)
    results.push({ asked: n, got, cost, remaining: rem, status: r.status, ms: r.ms })
    await sleep(600)
  }
  out.batchCap = results

  const full = results.filter(r => r.got >= r.asked * 0.9)
  const best = full.at(-1)
  if (best) {
    console.log(`\n  → lot fonctionnel jusqu'à ${best.asked} tokens pour ${best.cost} crédit(s)`)
    const perDay = 4000   // tokens suivis
    const cycles = 288    // toutes les 5 min
    console.log(`  → étage 3 sans lot   : ${(perDay * cycles).toLocaleString()} appels/jour`)
    console.log(`  → étage 3 avec lot   : ${Math.ceil(perDay / best.asked * cycles).toLocaleString()} appels/jour`)
  }
}

async function main() {
  console.log('POC Mobula — passe 4 —', new Date().toISOString())
  console.log('='.repeat(70))
  await pulseRaw()
  const pool = await harvest()
  await batchCap(pool)

  mkdirSync('poc/out', { recursive: true })
  writeFileSync('poc/out/findings4.json', JSON.stringify(out, null, 2))
  console.log('\nDétail : poc/out/findings4.json')
}

main().catch(e => { console.error(e); process.exit(1) })
