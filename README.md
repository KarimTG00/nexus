# Nexus — Multi-Chain Memecoin Screener with Self-Calibrating Filters | Built with Mobula API

> Nexus is an open-source memecoin discovery and screening engine that detects, filters and scores newly launched tokens across multiple blockchains using the [Mobula API](https://mobula.io), a unified multi-chain market data provider for on-chain applications.

Nexus scans **four blockchains** (Solana, Base, BNB Smart Chain, Robinhood Chain) on a **5-minute cycle**, observing roughly **1,000 tokens per cycle** of which **130–200 are newly created**. A full cycle — discovery, admission, monitoring, trigger analysis and outcome tracking — completes in **38–60 seconds** and consumes **14–17 Mobula credits**. Every filter decision is stored with its *measured value*, not just a pass/fail flag, so thresholds can be re-optimised on historical data without re-collecting anything.

[![Powered by Mobula API](https://img.shields.io/badge/Powered%20by-Mobula%20API-6C5CE7)](https://mobula.io)
[![Mobula Docs](https://img.shields.io/badge/Docs-Mobula-blue)](https://docs.mobula.io)
[![Mobula Bounty](https://img.shields.io/badge/Mobula-Bounty%20Program-orange)](https://mobula.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## TL;DR

- **What it does** — continuously discovers newly launched memecoins across 4 chains, applies security and market-structure filters, and scores survivors on a 0–100 scale.
- **What it uses** — the [Mobula API](https://mobula.io) for multi-chain discovery, batch market data and per-pool liquidity; Helius RPC and EVM bytecode analysis for contract security.
- **Who it's for** — traders who want systematic, auditable screening instead of manual chart-watching, and developers building on-chain data pipelines.

---

## About

Most memecoin scanners hard-code a set of thresholds and never revisit them. Nexus is built the other way round: **it records the measured value behind every decision**, so the thresholds themselves become testable hypotheses.

When a filter rejects a token for `top_holders = 34.2%` against a threshold of `30%`, both numbers are written to an append-only collection. Weeks later the same data answers a question no live system can answer in the moment: *did the tokens this filter rejected go on to succeed?* If they did, the filter is costing money rather than providing protection.

The engine tracks **rejected tokens as closely as accepted ones** — without a control group, filter efficacy cannot be measured at all.

Nexus currently runs in **calibration mode**: the full pipeline executes and records every decision, but sends no alerts. This is a configuration flag, not a separate code path.

---

## Why Mobula API?

- **One integration, 100 chains** — `/api/1/system-metadata` returns 100 supported chains. Adding Robinhood Chain (`evm:4663`) to Nexus took one configuration line, no new code.
- **Batch pricing that actually scales** — `/api/1/market/multi-data` returns **50 tokens for 1 credit** (measured). Monitoring 4,000 tokens drops from 1,152,000 daily calls to roughly 3,100.
- **Multi-view discovery** — `POST /api/2/pulse` accepts **up to 10 views in a single request for 1 credit**, each with its own chain, lifecycle model, sort order and server-side filters.
- **Server-side filtering** — 20+ filterable fields including `liquidity`, `top_10_holdings_percentage`, `holders_count`, `bundlers_holdings_percentage` and `organic_volume_1h`, so the response is filled with qualifying tokens instead of noise.
- **Lifecycle-aware buckets** — Pulse separates `new`, `bonding` and `bonded`, which maps directly onto the bonding-curve lifecycle. The `bonded` bucket *is* the launchpad graduation event.
- **126 fields per token** — including unique `buyers_*`, `sellers_*` and `traders_*` per time window, which is what makes velocity measurable at all.

---

## Mobula API vs Alternatives

| Capability | Mobula API | DexScreener | Direct RPC |
|---|---|---|---|
| Chains from one endpoint | 100 | ~90 | 1 per node |
| Batch market data | **50 tokens / 1 credit** | 30 pairs total per call | 1 call per token |
| Unique buyers/sellers per window | ✅ | ❌ (tx counts only) | requires indexing |
| Server-side filtering | ✅ 20+ fields | ❌ | ❌ |
| New-listing feed | ✅ 3 lifecycle buckets | ❌ | event subscription |
| Holder concentration (top 10/50/100) | ✅ | ❌ | requires enumeration |
| Auth required | API key | none | node access |

Nexus uses **DexScreener as a secondary source** for pool data, because `token/markets` responses were observed to vary between calls. The two sources are composed behind a single interface — see [Architecture](#tech-stack).

---

## Features

| Feature | Detail |
|---|---|
| Multi-chain discovery | 4 active chains, adding one = 1 config line |
| Two-phase admission | instant security checks, then activity check at t+15min |
| Contract security | Solana mint/freeze authority via RPC; EVM bytecode analysis via viem |
| Surveillance tiers | hot 5min / warm 30min / cold 6h — cuts monitoring cost ~7.5× |
| Multi-pool aggregation | sums liquidity across all pools; one token was observed with 25 |
| Rug vs migration | a liquidity collapse with a replacement pool is a migration, not a rug |
| Append-only decision log | every filter's measured value, threshold and outcome |
| Config versioning | every threshold change is a new version with a traced diff |
| Plugin filters | drop a file in `pipeline/filters/` — no pipeline code changes |

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24, ES modules |
| Market data | [Mobula API](https://mobula.io) (primary), DexScreener (secondary) |
| Chain access | Helius RPC (Solana), viem (EVM) |
| Storage | MongoDB 8 — 25 collections, time-series + TTL |
| Cache / limits | Redis (in-memory fallback for single-process) |
| Logging | pino, with automatic secret redaction |
| Deployment | Docker on Railway |

**Design rule:** the pipeline never imports a concrete data source. It depends on a `DataSource` interface with a declared `capabilities` set, so sources can be swapped or composed by configuration.

---

## Quick Start

```bash
git clone https://github.com/KarimTG00/nexus.git
cd nexus
npm install

cp .env.example .env      # then fill in your keys
npm run db:init           # creates 25 collections, indexes, validators
npm run boot              # verifies connections and configuration
npm run dev               # starts the pipeline
```

Get a free Mobula API key at [mobula.io](https://mobula.io), or try the endpoints without signing up via the [Demo API (no signup)](https://demo-api.mobula.io).

---

## Mobula API Integration

Discovery uses a single `POST` request carrying up to 10 views. Four chains × three lifecycle buckets is 12 views, so a full sweep costs **2 credits**:

```js
const views = []
for (const chainId of ['solana:solana', 'evm:8453', 'evm:56', 'evm:4663']) {
  for (const model of ['new', 'bonding', 'bonded']) {
    views.push({
      name: `${chainId}|${model}`,
      model,
      chainId: [chainId],
      limit: 50,
      sortBy: 'created_at',
      sortOrder: 'desc',
      filters: { liquidity: { gte: 500 } }   // server-side, keeps the response useful
    })
  }
}

const res = await fetch('https://api.mobula.io/api/2/pulse', {
  method: 'POST',
  headers: { Authorization: process.env.MOBULA_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ views: views.slice(0, 10) })   // API cap: 10 views per request
})

const data = await res.json()
// → { "solana:solana|new": { data: [...] }, ... }
```

Each Pulse item exposes 126 fields. The token itself sits behind a pointer — `pair.baseToken` is the *string* `"token0"` or `"token1"`:

```js
const pair = item.pair
const base = pair[pair.baseToken]          // the memecoin
const quote = pair[pair.quoteToken]        // SOL, WETH…

const velocity = {
  buyers:  item.buyers_5min,               // unique wallets, not tx count
  sellers: item.sellers_5min,
  traders: item.traders_5min,
  trades:  item.trades_5min
}

const interestScore = velocity.buyers - velocity.sellers
const washIndex = velocity.trades / velocity.traders   // > 8 suggests fabricated volume
```

Batch monitoring — 50 tokens for a single credit:

```js
const url = 'https://api.mobula.io/api/1/market/multi-data'
  + `?assets=${addresses.slice(0, 50).join(',')}`
  + `&blockchain=${encodeURIComponent('solana:solana')}`

const { data } = await (await fetch(url, {
  headers: { Authorization: process.env.MOBULA_KEY }
})).json()
// data is keyed by token address
```

> **Note on market cap:** for multi-chain assets Mobula returns an **aggregated** market cap while `liquidity` stays chain-local. Verified on USDC: identical `market_cap` on Solana and Base, different liquidity. Nexus stores `contracts_count` alongside every decision so this is never silently compared across chains.

---

## Mobula API Endpoints Used

| Endpoint | Method | Purpose in Nexus | Cost |
|---|---|---|---|
| `/api/2/pulse` | POST | Discovery — up to 10 filtered views per request | 1 credit |
| `/api/1/market/multi-data` | GET | Batch market cap / price / liquidity | 1 credit per 50 tokens |
| `/api/2/token/markets` | GET | All pools of a token, per-pool liquidity and velocity | 1 credit |
| `/api/1/market/data` | GET | Single-token detail and `contracts[]` for multi-chain linking | 1 credit |
| `/api/1/system-metadata` | GET | Supported chain list (100 chains) | 1 credit |

Full reference: [Mobula API reference](https://docs.mobula.io/rest-api-reference/introduction). A TypeScript client is available as [@mobula_labs/sdk](https://www.npmjs.com/package/@mobula_labs/sdk).

---

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `MOBULA_KEY` | ✅ | Mobula API key — discovery and market data |
| `MONGODB_URI` | ✅ | MongoDB connection string |
| `HELIUS_KEY` | ✅ | Solana RPC — mint / freeze authority checks |
| `REDIS_URL` | — | Shared rate limiter; falls back to memory if absent |
| `RPC_BASE`, `RPC_BNB`, `RPC_ROBINHOOD` | — | Override default public EVM RPCs |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error` |

---

## Demo

`npm run boot` — connection and configuration check:

```
Environment
  ✓ MONGODB_URI          MongoDB cluster URI
  ✓ MOBULA_KEY           Mobula API key
  ✓ HELIUS_KEY           Helius API key (Solana RPC)

MongoDB
  ✓ connected to « memecoins »
  ✓ 25 collections in place

Configuration
  ✓ version 7 active
  ✓ chains enabled: solana:solana, evm:8453, evm:56, evm:4663
  ✓ calibration mode (alerts disabled)
  ✓ trigger thresholds: 150K, 500K, 1000K, 5000K
  ✓ Mobula batch: 50 tokens/credit
```

A live pipeline cycle:

```
cycle 1 : 60s, 16 credits — seen 849, admitted 146, promoted 0, monitored 12
cycle 2 : 38s, 14 credits — seen 810, admitted 0,   promoted 1, monitored 0

daily funnel
  seen 6697 → new 1409 → admitted 1061 → promoted 3
  monitored 59 → threshold crossings 1 → alerts 0
  admission rejections: { low_liquidity: 346, token_security: 2 }
```

A recorded decision — every filter with its measured value:

```
PONYX — 5M threshold — alerted — score 70/100

  flat_velocity   1.9    (buyer rate accelerating)
  sell_pressure   2.26   threshold 1.2
  top_holders     9.83   threshold 30
  wash_trading    2.5    threshold 8
  lp_not_secured  null   skipped — not available on this chain

  subscores: velocity 100, flow 23, security 90, social 0
```

---

## FAQ

### How does Nexus use the Mobula API?

Nexus calls four Mobula endpoints. `POST /api/2/pulse` drives discovery with up to 10 server-filtered views per request. `/api/1/market/multi-data` monitors market caps in batches of 50 tokens per credit. `/api/2/token/markets` supplies per-pool liquidity and velocity when a token crosses a threshold. `/api/1/market/data` resolves multi-chain contract links.

### Why use the Mobula API instead of querying nodes directly?

Unique buyers and sellers per time window cannot be read from a node without building an indexer. Mobula exposes `buyers_5min`, `sellers_5min` and `traders_5min` directly, which is the difference between a measurable velocity signal and an unusable one. Multi-chain coverage from a single integration is the second reason.

### How many Mobula credits does Nexus consume?

Measured at 14–17 credits per 5-minute cycle across 4 chains: 2 for discovery, the remainder for batch monitoring and per-token deep analysis. That is roughly 4,300 credits per day.

### What is the difference between a rug pull and a pool migration?

Seen from a single pool they are identical — liquidity disappears. Nexus classifies a collapse as a **migration** when a pool created within the last 60 minutes holds comparable liquidity, which is exactly what happens at launchpad graduation. Only a collapse with no replacement is recorded as a rug. Conflating the two would corrupt the outcome data permanently.

### Why does Nexus track rejected tokens?

Because filter quality cannot be measured without a control group. If tokens rejected by a filter succeed at the same rate as tokens that passed it, that filter discriminates nothing. Every rejection is stored with the measured value that caused it, so any threshold can be re-tested against history.

### What does calibration mode do?

The full pipeline runs and records every decision, but no alerts are sent. It is a single configuration flag (`features.alerts.enabled`), not a separate code path, so what is measured in calibration is exactly what will run in production.

### Which blockchains does Nexus support?

Solana, Base, BNB Smart Chain and Robinhood Chain are active. Mobula exposes 100 chains, and enabling another is one configuration line — one EVM adapter covers the whole EVM family.

---

## Roadmap

| Phase | Status |
|---|---|
| Discovery, admission, security filters | ✅ shipped |
| Surveillance tiers, batch monitoring | ✅ shipped |
| Threshold triggers, deep analysis, scoring | ✅ shipped |
| Outcome tracking, rug detection, verdicts | ✅ shipped |
| Telegram alert delivery | in progress |
| Swap collector — per-wallet position tracking | planned |
| Filter calibration reports from recorded outcomes | planned |
| Web dashboard | planned |
| Wallet and deployer reputation scoring | planned |

---

## Contributing

Issues and pull requests are welcome. Filters and metrics are plugins — adding one means dropping a file into `src/pipeline/filters/` or `src/pipeline/metrics/` with a `name`, a `configKey` and an `evaluate()` function. No pipeline code changes are needed.

Two rules are non-negotiable:

1. **Never hard-code a threshold.** All tunable values live in `config_versions` so they remain optimisable.
2. **`trigger_snapshots` and `outcomes` are append-only.** Add fields, never rename or repurpose them — that history cannot be regenerated.

---

## Mobula Bounty Program

Nexus was built for the [Mobula Bounty Program](https://mobula.io), which rewards open-source projects using real on-chain data from the Mobula API. If you are building with Mobula, the program is worth a look.

---

## Resources

- [Mobula API](https://mobula.io) — multi-chain market data
- [Mobula documentation](https://docs.mobula.io) — guides and integration walkthroughs
- [Mobula API reference](https://docs.mobula.io/rest-api-reference/introduction) — endpoint specifications
- [Demo API (no signup)](https://demo-api.mobula.io) — try the endpoints without a key
- [Mobula blog](https://blog.mobula.io) — product updates and technical write-ups
- [@mobula_labs/sdk](https://www.npmjs.com/package/@mobula_labs/sdk) — official TypeScript SDK
- [Mobula GitHub](https://github.com/MobulaFi) — open-source repositories
- [Mobula Bounty Program](https://mobula.io) — build with Mobula, get rewarded

---

## GitHub Topics

```
mobula, mobula-api, crypto-api, web3, blockchain-data, memecoin,
solana, base, bnb-chain, token-screener, defi, nodejs, mongodb
```

---

## Structured Data

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Nexus",
  "description": "Open-source multi-chain memecoin screener that discovers, filters and scores newly launched tokens using the Mobula API, with an append-only decision log enabling filter thresholds to be re-optimised on historical data.",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Linux, macOS, Windows",
  "programmingLanguage": "JavaScript",
  "license": "https://opensource.org/licenses/MIT",
  "codeRepository": "https://github.com/KarimTG00/nexus",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "isBasedOn": {
    "@type": "WebAPI",
    "name": "Mobula API",
    "url": "https://mobula.io",
    "description": "Multi-chain crypto market data API covering 100 blockchains"
  }
}
</script>
```

---

**Keywords:** Mobula API, multi-chain crypto data, memecoin screener, token discovery API, Solana token scanner, Base chain data, BNB Smart Chain API, blockchain market data, on-chain analytics, DEX liquidity API, crypto trading bot, Node.js crypto API

## License

MIT — see [LICENSE](LICENSE).
