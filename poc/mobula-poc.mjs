/**
 * POC Mobula — valide les hypothèses de l'étage 0 et 3 avant de coder le pipeline.
 *
 * Répond aux 7 questions de docs/face1-pipeline.md :
 *   Q1 flux de nouveaux listings      Q5 pools par token
 *   Q2 couverture des chaînes         Q6 requêtes par lot  <-- la plus importante
 *   Q3 nombre de holders              Q7 limites de débit / coût
 *   Q4 métriques agrégées ou par pool
 *
 * Usage : node --env-file=.env poc/mobula-poc.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const KEY = process.env.MOBULA_KEY
if (!KEY) {
  console.error('MOBULA_KEY absent. Lancer avec : node --env-file=.env poc/mobula-poc.mjs')
  process.exit(1)
}

const BASE = 'https://api.mobula.io'
const findings = []
const raw = {}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Appel HTTP instrumenté : latence, statut, en-têtes de quota. */
async function call(path, { method = 'GET', body = null, label = '' } = {}) {
  const url = path.startsWith('http') ? path : BASE + path
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const ms = Date.now() - t0
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* réponse non-JSON */ }

    const quota = {}
    for (const [k, v] of res.headers.entries()) {
      if (/rate|limit|remaining|credit|quota|retry/i.test(k)) quota[k] = v
    }

    return {
      ok: res.ok, status: res.status, ms, json, quota,
      snippet: json ? null : text.slice(0, 300)
    }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e) }
  }
}

function note(question, verdict, detail, impact = null) {
  findings.push({ question, verdict, detail, impact })
  const mark = { OK: '[OK]  ', KO: '[KO]  ', WARN: '[WARN]' }[verdict] || '[?]   '
  console.log(`${mark} ${question} — ${detail}`)
  if (impact) console.log(`        impact : ${impact}`)
}

/** Renvoie les clés d'un objet imbriqué, aplaties, pour inspecter un schéma inconnu. */
function shape(obj, prefix = '', depth = 0, out = []) {
  if (depth > 2 || obj === null || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (Array.isArray(v)) {
      out.push(`${p}[] (${v.length})`)
      if (v.length && typeof v[0] === 'object') shape(v[0], `${p}[]`, depth + 1, out)
    } else if (v && typeof v === 'object') {
      shape(v, p, depth + 1, out)
    } else {
      out.push(`${p} = ${JSON.stringify(v)?.slice(0, 60)}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------

async function probe0_auth() {
  console.log('\n=== Q0 — Authentification ===')
  const r = await call('/api/1/system-metadata', { label: 'metadata' })
  if (!r.ok) {
    note('Q0 auth', 'KO', `HTTP ${r.status} ${r.snippet || r.error || ''}`,
      'Rien ne peut être testé tant que la clé ne passe pas.')
    return false
  }
  note('Q0 auth', 'OK', `HTTP 200 en ${r.ms} ms`)
  raw.systemMetadata = r.json
  if (Object.keys(r.quota).length) {
    console.log('        en-têtes de quota :', JSON.stringify(r.quota))
  }
  return true
}

async function probe2_chains() {
  console.log('\n=== Q2 — Couverture des chaînes ===')
  const md = raw.systemMetadata
  const blob = JSON.stringify(md || {}).toLowerCase()
  const wanted = ['solana', 'ethereum', 'base', 'bnb', 'arbitrum', 'robinhood']
  const found = wanted.filter(c => blob.includes(c))
  const missing = wanted.filter(c => !found.includes(c))

  // Tente d'extraire une liste exploitable
  let list = null
  const cands = [md?.data?.blockchains, md?.blockchains, md?.data?.chains, md?.chains]
  for (const c of cands) if (Array.isArray(c)) { list = c; break }
  if (list) {
    raw.chains = list.slice(0, 200)
    console.log(`        ${list.length} chaînes déclarées`)
  }

  note('Q2 chaînes', missing.length ? 'WARN' : 'OK',
    `présentes : ${found.join(', ') || 'aucune'}${missing.length ? ` | absentes : ${missing.join(', ')}` : ''}`,
    missing.length ? `Chaînes non couvertes = angle mort permanent (voie ② de M7).` : null)
}

async function probe1_pulse() {
  console.log('\n=== Q1 — Flux de nouveaux listings (Pulse) ===')

  const r = await call('/api/2/pulse?limit=50&chainId=solana:solana')
  if (!r.ok) {
    note('Q1 listings', 'KO', `HTTP ${r.status} ${r.snippet || ''}`,
      'Sans flux de listings, la découverte repose entièrement sur les webhooks natifs.')
    return
  }

  const items = r.json?.data ?? r.json?.result ?? (Array.isArray(r.json) ? r.json : [])
  raw.pulseSample = items.slice(0, 2)
  raw.pulseShape = items.length ? shape(items[0]) : []

  note('Q1 listings', items.length ? 'OK' : 'WARN',
    `${items.length} entrées en ${r.ms} ms`)

  if (!items.length) return

  // Fraîcheur : quel est le token le plus récent ?
  const now = Date.now()
  const ages = items.map(it => {
    const t = it.createdAt ?? it.created_at ?? it.pool?.createdAt ?? it.listed_at
    const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t)
    return Number.isFinite(ms) ? (now - ms) / 60000 : null
  }).filter(Number.isFinite).sort((a, b) => a - b)

  if (ages.length) {
    note('Q1 fraîcheur', ages[0] < 30 ? 'OK' : 'WARN',
      `le plus récent a ${ages[0].toFixed(1)} min | médiane ${ages[Math.floor(ages.length / 2)].toFixed(0)} min`,
      ages[0] > 30 ? "Délai d'indexation : l'écoute native reste indispensable." : null)
  } else {
    note('Q1 fraîcheur', 'WARN', 'aucun champ de date reconnu',
      'À vérifier manuellement dans pulseShape.')
  }

  // Champs directement exploitables par notre pipeline
  const flat = raw.pulseShape.join('|').toLowerCase()
  const useful = {
    'liquidité': /liquidity/.test(flat),
    'market cap': /marketcap|market_cap/.test(flat),
    'volume': /volume/.test(flat),
    'achats/ventes': /buys|sells/.test(flat),
    'sécurité (honeypot/tax)': /honeypot|buytax|selltax/.test(flat),
    'top10 holders': /top10/.test(flat),
    'dev holdings': /devholding/.test(flat),
    'liste de holders': /holders_list|holderslist/.test(flat),
    'statut bonding': /bonded|bondingpercentage/.test(flat)
  }
  const have = Object.entries(useful).filter(([, v]) => v).map(([k]) => k)
  note('Q1 richesse', have.length >= 5 ? 'OK' : 'WARN',
    `champs exploitables : ${have.join(', ') || 'aucun'}`,
    have.length >= 5
      ? "Pulse peut couvrir à lui seul une partie de l'admission (étage 1) — moins d'appels RPC."
      : null)

  // Pagination = seul moyen d'incrémentalité (pas de filtre 'since')
  const r2 = await call('/api/2/pulse?limit=50&offset=50&chainId=solana:solana')
  const items2 = r2.json?.data ?? r2.json?.result ?? []
  const ids1 = new Set(items.map(i => i.address ?? i.token0?.address ?? JSON.stringify(i).slice(0, 40)))
  const overlap = items2.filter(i =>
    ids1.has(i.address ?? i.token0?.address ?? JSON.stringify(i).slice(0, 40))).length
  note('Q1 pagination', r2.ok && overlap === 0 ? 'OK' : 'WARN',
    `offset=50 → ${items2.length} entrées, ${overlap} doublons avec la page 1`,
    'Pas de filtre "depuis tel instant" : on pagine et on dédoublonne contre la base.')
}

async function probe6_batch() {
  console.log('\n=== Q6 — Requêtes par lot (LA question) ===')

  // Quelques tokens connus, multi-chain
  const tokens = [
    { blockchain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, // USDC sol
    { blockchain: 'evm:1',  address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },   // USDT eth
    { blockchain: 'evm:8453', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }   // USDC base
  ]

  // Tentative 1 : POST batch de prix
  const p = await call('/api/1/market/multi-data', {
    method: 'POST',
    body: { assets: tokens }
  })
  if (p.ok) {
    const n = Object.keys(p.json?.data ?? {}).length
    note('Q6 batch POST', n > 1 ? 'OK' : 'WARN',
      `/api/1/market/multi-data → ${n} tokens en ${p.ms} ms`,
      n > 1 ? 'Les ~154 000 requêtes/jour de l\'étage 3 tombent d\'un facteur ~50-100.' : null)
    raw.batchSample = p.json
  } else {
    // Tentative 2 : GET multi-data avec assets séparés par virgule
    const q = await call('/api/1/market/multi-data?assets=' +
      encodeURIComponent(tokens.map(t => t.address).join(',')))
    if (q.ok) {
      const n = Object.keys(q.json?.data ?? {}).length
      note('Q6 batch GET', n > 1 ? 'OK' : 'WARN',
        `/api/1/market/multi-data?assets=… → ${n} tokens en ${q.ms} ms`,
        n > 1 ? 'Batch confirmé par GET.' : null)
      raw.batchSample = q.json
    } else {
      note('Q6 batch', 'KO',
        `POST ${p.status} / GET ${q.status}`,
        'Sans lot, les tiers de surveillance restent indispensables et le budget grimpe.')
    }
  }
}

async function probe5_pools() {
  console.log('\n=== Q5 — Pools par token (fragmentation / migration) ===')
  const r = await call('/api/2/token/markets?blockchain=solana&address=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&limit=25')
  if (!r.ok) {
    note('Q5 pools', 'KO', `HTTP ${r.status} ${r.snippet || ''}`,
      'On dépendra uniquement des événements de factory pour maintenir pools[].')
    return
  }
  const d = r.json?.data ?? r.json
  const markets = d?.markets ?? d?.data ?? (Array.isArray(d) ? d : [])
  const total = d?.totalCount ?? markets.length
  const hasLiq = markets.length && /liquidity/i.test(JSON.stringify(markets[0]))
  raw.poolsSample = markets.slice(0, 3)

  note('Q5 pools', markets.length ? 'OK' : 'WARN',
    `${markets.length} pools renvoyés (total déclaré ${total}), liquidité par pool : ${hasLiq ? 'oui' : 'non'}`,
    markets.length && hasLiq
      ? 'Filet de sécurité pour pools[] : on détecte migrations et fragmentation sans dépendre des factories.'
      : null)
}

async function probe3_holders() {
  console.log('\n=== Q3 — Holders ===')
  const r = await call('/api/1/market/token-holder-positions?blockchain=solana&address=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&limit=10')
  if (r.ok) {
    const d = r.json?.data ?? r.json
    const n = Array.isArray(d) ? d.length : Object.keys(d ?? {}).length
    note('Q3 holders', 'OK', `endpoint disponible, ${n} entrées en ${r.ms} ms`,
      'Sert à recaler le compte absolu affiché dans l\'alerte. La vélocité reste issue du flux de swaps.')
    raw.holdersShape = shape(Array.isArray(d) ? d[0] : d)
  } else {
    note('Q3 holders', 'WARN', `HTTP ${r.status}`,
      'Non bloquant : la vélocité vient du flux de swaps. On perd juste le compte absolu.')
  }
}

async function probe7_rate() {
  console.log('\n=== Q7 — Limites de débit ===')
  const N = 12
  const t0 = Date.now()
  const results = []
  for (let i = 0; i < N; i++) {
    results.push(await call('/api/2/pulse?limit=1&chainId=solana:solana'))
  }
  const total = Date.now() - t0
  const okCount = results.filter(r => r.ok).length
  const throttled = results.filter(r => r.status === 429).length
  const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / N)
  const quota = results.at(-1)?.quota ?? {}

  note('Q7 débit', throttled ? 'WARN' : 'OK',
    `${okCount}/${N} OK, ${throttled} en 429, latence moyenne ${avg} ms, ${N} appels en ${total} ms`,
    throttled ? 'Rate limiter Redis obligatoire dès la v1, avec back-off.' : null)

  if (Object.keys(quota).length) {
    console.log('        quota :', JSON.stringify(quota))
    raw.quotaHeaders = quota
  } else {
    note('Q7 quota', 'WARN', 'aucun en-tête de quota renvoyé',
      'Impossible de connaître le solde restant : il faudra compter côté client.')
  }
}

async function probe4_accuracy() {
  console.log('\n=== Q4 — Justesse & agrégation (contrôle croisé DexScreener) ===')
  const addr = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const m = await call(`/api/1/market/data?asset=${addr}&blockchain=solana`)
  const d = await call(`https://api.dexscreener.com/latest/dex/tokens/${addr}`)

  const mob = m.json?.data
  const dex = d.json?.pairs?.[0]
  if (!mob || !dex) {
    note('Q4 justesse', 'WARN', 'comparaison impossible (une des deux sources muette)')
    return
  }
  const mobPrice = mob.price
  const dexPrice = parseFloat(dex.priceUsd)
  const diff = Math.abs(mobPrice - dexPrice) / dexPrice * 100

  note('Q4 justesse', diff < 2 ? 'OK' : 'WARN',
    `prix Mobula ${mobPrice} vs DexScreener ${dexPrice} → écart ${diff.toFixed(2)} %`)

  const liqAgg = mob.liquidity
  note('Q4 agrégation', 'INFO',
    `liquidité Mobula ${liqAgg} vs pool principal DexScreener ${dex.liquidity?.usd}`,
    liqAgg > (dex.liquidity?.usd ?? 0) * 1.5
      ? 'Mobula semble AGRÉGER sur tous les pools → règle une partie du problème de fragmentation.'
      : 'Mobula semble renvoyer un pool unique → l\'agrégation reste à notre charge.')
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('POC Mobula —', new Date().toISOString())
  console.log('='.repeat(70))

  if (!await probe0_auth()) return finish()
  await probe2_chains()
  await sleep(300)
  await probe1_pulse()
  await sleep(300)
  await probe6_batch()
  await sleep(300)
  await probe5_pools()
  await sleep(300)
  await probe3_holders()
  await sleep(300)
  await probe4_accuracy()
  await sleep(300)
  await probe7_rate()
  finish()
}

function finish() {
  mkdirSync('poc/out', { recursive: true })
  writeFileSync('poc/out/findings.json',
    JSON.stringify({ at: new Date().toISOString(), findings, raw }, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('RÉSUMÉ')
  for (const f of findings) console.log(`  ${f.verdict.padEnd(4)} ${f.question} — ${f.detail}`)
  console.log('\nDétail complet : poc/out/findings.json')
}

main().catch(e => { console.error('Échec du POC :', e); process.exit(1) })
