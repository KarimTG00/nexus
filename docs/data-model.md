# Modèle de données MongoDB

> Voir `face1-pipeline.md` (pipeline temps réel) et `face2-modules.md` (boucle analytique)

## Principes

1. **Aucune collection `swaps`.** Un swap est un événement : il met à jour un état, puis disparaît.
2. **Toute métrique est calculable de façon incrémentale**, en O(1) à l'arrivée d'un événement.
3. **Toute collection a une politique de rétention définie dès sa création.**
4. **Le dashboard ne calcule rien** : il lit les collections `analytics_*`, pré-calculées en batch.
5. **Identité multi-chain** : `_id` composite en chaîne de caractères (`"solana:ABC123..."`). Pas d'index supplémentaire, et les références restent lisibles.
6. **Évolutivité** (voir `architecture.md`) : chaque document porte un `schema_version`. Les zones destinées à grossir — `candidates`, `filters[]`, `subscores`, `analytics_*` — sont **sans validateur**, pour accepter de nouvelles clés sans migration. Le noyau (`_id`, enums `status` / `tier` / `verdict`, champs requis) est **validé**, parce qu'une faute de frappe y casserait le pipeline sans alarme.
7. **Migrations additives uniquement.** `trigger_snapshots` et `outcomes` sont des registres **append-only irremplaçables** : on y ajoute des champs, jamais on ne renomme ni ne réaffecte.

## Les 14 collections, en 4 familles

| Famille | Collections |
|---|---|
| **Cœur** | `tokens`, `token_metrics`, `token_metrics_hourly`, `token_metrics_daily`, `positions` |
| **Décisions** | `trigger_snapshots`, `outcomes`, `alerts`, `rejected_seen` |
| **Réputation** | `wallets`, `deployers`, `clusters` |
| **Gouvernance & dashboard** | `config_versions`, `analytics_*` |

---

# Famille 1 — Cœur

## `tokens`

Le document central. **Petit et chaud** : mis à jour toutes les 5 min pour les tokens `hot`. On y garde uniquement ce qui doit être lu ou écrit souvent — tout ce qui est volumineux vit ailleurs.

```js
{
  _id: "solana:7xKq...",            // {chain}:{address}
  chain: "solana",
  address: "7xKq...",

  // Identité
  symbol: "PEPE2",
  name: "Pepe The Second",
  decimals: 6,
  supply: 1000000000,

  // Origine
  deployer: "9aBc...",
  deployer_funder: "3xYz...",       // qui a payé le déploiement → clustering M4
  launchpad: "pump.fun",            // null si lancement direct

  // Pools — un token possède un ENSEMBLE de pools
  pools: [
    { address: "8kLm...", dex: "raydium", quote: "SOL",
      created_at: ISODate, liquidity_usd: 42000, active: true },
    { address: "2pQr...", dex: "pumpswap", quote: "SOL",
      created_at: ISODate, liquidity_usd: 1200, active: false }
  ],
  primary_pool: "8kLm...",          // le plus profond, réévalué à chaque cycle

  // Cycle de vie
  status: "tracked",                // discovered | pending_activity | tracked
                                    // | triggered | alerted | quarantine | archived
  tier: "hot",                      // hot | warm | cold | archived
  next_check_at: ISODate,           // ← LE champ du chemin chaud (voir index)
  discovered_at: ISODate,
  admitted_at: ISODate,
  archived_at: null,

  // Marché (dernier état connu)
  market: {
    mc: 148000, price: 0.000148, liquidity_usd: 42000,
    volume_24h: 310000, updated_at: ISODate
  },

  // Sécurité de base, évaluée une fois à t=0
  security: {
    mint_authority: false,          // Solana
    freeze_authority: false,
    ownership_renounced: null,      // EVM
    honeypot: null,
    tax_buy: null, tax_sell: null,
    checked_at: ISODate
  },

  // Vélocité courante (dénormalisée depuis Redis, pour le dashboard)
  velocity: {
    score_5m: 145, slope: "up", unique_traders_5m: 187,
    buy_sell_ratio: 11.1, wash_index: 1.67, updated_at: ISODate
  },

  // Historique des franchissements
  triggers: [
    { threshold: 150000, at: ISODate, decision: "alerted", score: 78 }
  ],

  // Seconde chance (rejets low_liquidity / low_activity)
  second_chance: { retry_count: 2, until: ISODate },

  // Rempli à la compaction uniquement (voir Rétention)
  frozen_early_buyers: null,

  config_version: 7                 // sous quelles règles ce token est traité
}
```

**Index :**

```js
{ status: 1, next_check_at: 1 }     // ← chemin chaud : "quoi vérifier maintenant ?"
{ status: 1, "market.mc": -1 }
{ deployer: 1 }
{ "pools.address": 1 }              // retrouver un token depuis un pool (flux de swaps)
{ chain: 1, symbol: 1 }             // recherche dashboard
```

⚠️ **`next_check_at` plutôt qu'un scan par tier.** Le janitor écrit la prochaine échéance au moment où il classe le token. Le poller fait alors `find({ next_check_at: { $lte: now } })` — un simple parcours d'index, au lieu de scanner 4 000 documents toutes les 5 minutes.

**Taille :** ~2 Ko. ~600 nouveaux/jour.

---

## `token_metrics` — time-series 5 minutes

Collection **time-series MongoDB** (compression native). Un document par token et par tranche de 5 min, **uniquement si le token a tradé**.

```js
{
  ts: ISODate,                      // timeField
  meta: { token: "solana:7xKq...", chain: "solana" },   // metaField

  new_entrants: 154,
  exits: 9,
  score: 145,                       // new_entrants − exits
  buys: 312, sells: 28,
  swaps: 340,
  unique_traders: 187,
  volume_usd: 84000,
  price: 0.000148,
  mc: 148000,
  liquidity_usd: 42000
}
```

**Taille :** ~150 o/doc. ~1 500 tokens actifs × 288 = ~432 000 docs/jour ≈ **65 Mo/jour**.

**Rétention :** TTL **7 jours**, puis agrégation.

## `token_metrics_hourly` / `token_metrics_daily`

Mêmes champs, agrégés par un job du `worker-analytics`. Rétention : **90 jours** pour l'horaire, **illimitée** pour le journalier (~1 Ko/token/jour, négligeable).

---

## `positions` — une ligne par couple wallet × token

**La collection du chemin d'écriture chaud.** Un wallet qui fait 40 swaps sur un token produit **1 document, pas 40**.

```js
{
  _id: "solana:7xKq...:9wAl...",    // {chain}:{token}:{wallet} → upsert direct par _id
  wallet: "9wAl...",
  token: "solana:7xKq...",
  chain: "solana",

  // Entrée
  first_buy_ts: ISODate,
  first_buy_mc: 62000,              // MC au moment de l'entrée → précocité (M2)
  first_buy_rank: 14,               // 14e acheteur du token → détection d'initié (M3)

  // Flux cumulé
  bought_amount: 1200000, bought_usd: 180,
  sold_amount: 1200000, sold_usd: 940,
  avg_entry_price: 0.00015, avg_exit_price: 0.00078,
  max_position_usd: 180,

  // Résultat
  realized_pnl_usd: 760,
  realized_pnl_pct: 422,
  closed: true,                     // ≥ 90 % de la position max revendue
  closed_at: ISODate,
  last_activity_ts: ISODate
}
```

**Index :**

```js
{ token: 1, first_buy_ts: 1 }       // early buyers d'un token
{ wallet: 1, closed: 1, closed_at: -1 }   // PnL d'un wallet (M2)
{ token: 1, closed_at: 1 }          // sorties avant un rug (M3)
{ last_activity_ts: 1 }             // purge
```

⚠️ **`_id` composite = upsert sans index secondaire.** C'est le chemin le plus chaud du système (~1,5 M mises à jour/jour). Écrire par `_id` est l'opération la plus rapide possible en MongoDB.

**Taille :** ~250 o. ~500 000 couples distincts/jour bruts.

**Purge :** `closed = true` **ET** `closed_at < 90 j` **ET** `max_position_usd < 50` **ET** wallet absent de `wallets`.
→ État stationnaire **~3–4 Go**.

💡 **Les early buyers ne sont pas stockés deux fois.** Ils se déduisent de `positions` (`{token, first_buy_ts}`, limit 100). Ils ne sont figés dans `tokens.frozen_early_buyers` qu'à la compaction, avant la purge des positions.

---

# Famille 2 — Décisions

## `trigger_snapshots` — la collection la plus précieuse

Le contexte **figé** au moment exact de chaque franchissement. Petite, permanente, et c'est la vérité terrain de toutes les analyses de la face 2.

```js
{
  _id: "solana:7xKq...:150000",     // {chain}:{token}:{seuil} → verrou d'unicité
  token: "solana:7xKq...",
  chain: "solana",
  threshold: 150000,
  ts: ISODate,
  config_version: 7,                // ← sous quelles règles cette décision a été prise

  // Contexte au moment T
  context: {
    mc: 151200, age_minutes: 124, liquidity_usd: 42000,
    score_5m: 145, slope: "up",
    buy_sell_ratio: 11.1, unique_traders_5m: 187, wash_index: 1.67,
    top10_pct: 21.4, lp_secured: true, lp_burned_pct: 100,
    holders: 1240
  },

  // Les 9 métriques candidates de M6 — enregistrées même si inutilisées
  candidates: {
    liq_mc_ratio: 0.28,
    top20_buyers_concentration: 18.2,
    median_buyer_wallet_age_days: 210,
    common_funder_buyers_pct: 4.1,
    minutes_to_50k: 38,
    median_buy_size_usd: 62,
    holders_traders_ratio: 6.6,
    slippage_1k_pct: 0.9,
    launch_hour_utc: 14
  },

  // Chaque filtre évalué, AVEC sa valeur mesurée → permet le balayage de seuil (M5)
  filters: [
    { name: "flat_velocity",  value: "up",  threshold: "up",   passed: true },
    { name: "sell_pressure",  value: 11.1,  threshold: 1.2,    passed: true },
    { name: "wash_trading",   value: 1.67,  threshold: 8,      passed: true },
    { name: "top_holders",    value: 21.4,  threshold: 30,     passed: true },
    { name: "lp_not_secured", value: 100,   threshold: 95,     passed: true }
  ],

  // Décision
  decision: "alerted",              // alerted | rejected
  rejection_reason: null,           // nom du premier filtre échoué
  score: 78,
  subscores: { velocity: 87, flow: 74, security: 81, social: 34, deployer: 60 }
}
```

**Index :** `{ ts: -1 }`, `{ decision: 1, ts: -1 }`, `{ "filters.name": 1, "filters.passed": 1 }`

**Taille :** ~1,5 Ko × 20–60/jour = **~30 Mo/an**. **Conservation illimitée.**

⚠️ Stocker la **valeur mesurée** et pas seulement `passed: true/false` est ce qui rend possible le balayage de seuil de M5 : on peut rejouer n'importe quel seuil a posteriori sans recollecter de données.

---

## `outcomes` — le verdict

Un document par déclenchement, complété au fil des checkpoints.

```js
{
  _id: "solana:7xKq...:150000",     // même clé que le trigger_snapshot
  token: "solana:7xKq...",
  threshold: 150000,
  mc_at_trigger: 151200,
  decision: "alerted",              // dupliqué pour éviter une jointure

  checkpoints: {
    t1h:  { mc: 210000, liquidity_usd: 51000 },
    t6h:  { mc: 480000, liquidity_usd: 88000 },
    t24h: { mc: 920000, liquidity_usd: 130000 },
    t7d:  { mc: 640000, liquidity_usd: 110000 }
  },

  mc_max: 1150000,
  multiple_max: 7.6,                // mc_max / mc_at_trigger
  time_to_peak_hours: 31,
  drawdown_from_peak_pct: 44,

  alive: true,
  rugged: false,
  rug_ts: null,
  rug_type: null,                   // lp_pull | dev_dump | slow_bleed

  verdict: "SUCCESS"                // SUCCESS (≥5× sans rug) | SURVIVED | DEAD | RUGGED
}
```

⚠️ **Rug ≠ migration.** On ne marque `rugged: true` que si **aucun pool de remplacement** n'apparaît dans les 60 min suivant le retrait de liquidité. Confondre les deux empoisonne M1, M3 et M4.

**Index :** `{ verdict: 1 }`, `{ multiple_max: -1 }`, `{ rugged: 1, rug_ts: 1 }`

**Taille :** ~600 o. **Conservation illimitée.**

---

## `alerts`

Journal des envois Telegram : cooldown, historique dashboard, gestion du mute.

```js
{
  _id: ObjectId,
  token: "solana:7xKq...",
  threshold: 150000,
  sent_at: ISODate,
  score: 78,
  telegram_message_id: 48213,
  muted: false
}
```

**Index :** `{ token: 1, sent_at: -1 }` (cooldown 72 h), `{ sent_at: -1 }`

---

## `rejected_seen`

Trace légère des tokens rejetés à l'admission. Deux rôles : éviter de les re-traiter en boucle toutes les 5 min, et alimenter le mécanisme de **seconde chance**.

```js
{
  _id: "solana:5mNp...",
  reason: "low_liquidity",
  value: 2100, threshold: 5000,
  rejected_at: ISODate,
  retry_count: 3,
  next_retry_at: ISODate,           // null si non éligible à la seconde chance
  expires_at: ISODate               // ← TTL 30 jours
}
```

**Index :** `{ expires_at: 1 }` **TTL**, `{ next_retry_at: 1 }`

**Taille :** ~100 o × ~50 000/jour × 30 j = **~150 Mo**.

⚠️ TTL à **30 jours, pas 7** : M7 a besoin de savoir si un top gainer de la semaine avait été rejeté à l'admission.

---

# Famille 3 — Réputation

## `wallets` (M2 + M3)

Recalculée quotidiennement. Seuls les wallets franchissant une barre minimale ont un document.

```js
{
  _id: "solana:9wAl...",
  address: "9wAl...", chain: "solana",

  alpha: {
    score: 82,
    precocity_pct: 12,              // percentile médian du MC à l'entrée (bas = tôt)
    hit_rate: 0.41,
    hit_rate_wilson_low: 0.29,      // ← le classement se fait sur CETTE valeur
    profit_factor: 3.8,
    median_multiple: 2.4,
    n_closed: 47,
    selectivity: 2.1,               // tokens distincts achetés par jour
    updated_at: ISODate
  },

  toxic: {
    flagged: false,
    n_rug_involvement: 0,
    evidence: [],                   // [{ token, first_buy_rank, exit_before_rug_min, pnl }]
    updated_at: ISODate
  },

  funder: "3xYz...",                // dégroupage sybil
  cluster_id: null,
  is_bot: false,                    // selectivity > 50 tokens/jour
  first_seen: ISODate,
  last_seen: ISODate
}
```

**Index :** `{ "alpha.hit_rate_wilson_low": -1 }`, `{ "toxic.flagged": 1 }`, `{ funder: 1 }`

⚠️ Le classement alpha se fait sur la **borne inférieure de Wilson**, jamais sur le taux brut : sinon le haut du classement n'est composé que de wallets à 3 trades et 3 réussites. Minimum **15 positions fermées** pour être classé.

---

## `deployers` (M4)

```js
{
  _id: "solana:9aBc...",
  address: "9aBc...", chain: "solana",
  funder: "3xYz...",
  cluster_id: "clu_0042",

  n_launches: 7,
  n_rugged: 3, n_dead: 3, n_survived: 1, n_success: 0,
  rug_rate: 0.43,
  success_rate: 0.0,
  confidence: "medium",             // fonction de n_launches

  blacklisted: true,
  blacklist_reason: "cluster_3_rugs",
  launches: ["solana:7xKq...", "solana:2bDf..."],
  updated_at: ISODate
}
```

**Index :** `{ cluster_id: 1 }`, `{ blacklisted: 1 }`, `{ funder: 1 }`

⚠️ **Jamais bloquant pour un déployeur inconnu** — c'est la majorité des cas. Absence d'historique ≠ mauvais.

## `clusters` (M4)

```js
{
  _id: "clu_0042",
  chain: "solana",
  members: ["solana:9aBc...", "solana:4kPq...", "solana:8sRt..."],
  evidence: ["common_funder", "buyer_overlap"],
  n_launches: 19, n_rugged: 11,
  blacklisted: true,
  updated_at: ISODate
}
```

---

# Famille 4 — Gouvernance & dashboard

## `config_versions` (M8)

**Jamais supprimée.** Sans elle, comparer deux périodes n'a aucun sens : on ne saurait pas sous quelles règles chaque token a été jugé.

```js
{
  _id: 7,
  created_at: ISODate,
  created_by: "manual",             // manual | m8_proposal_accepted
  active: true,

  thresholds: {
    admission: { min_liquidity_usd: 5000, min_tx_15m: 30, min_wallets_15m: 20 },
    trigger:   [150000, 500000, 1000000, 5000000],
    filters:   { sell_pressure: 1.2, wash_index: 8, top_holders: 30, lp_secured: 95 },
    alert:     { min_score: 70, cooldown_hours: 72, max_per_hour: 6 }
  },
  weights: { velocity: 0.40, flow: 0.20, security: 0.20, social: 0.10, deployer: 0.10 },
  tiers: { hot_minutes: 5, warm_minutes: 30, cold_hours: 6 },

  diff_from_previous: [
    { path: "thresholds.filters.top_holders", from: 30, to: 38, source: "m8_sweep" }
  ]
}
```

## `analytics_*` — pré-calculées pour le dashboard

**Le dashboard ne fait aucune agrégation à la volée.** Chaque écran lit sa collection, produite en batch par le `worker-analytics`.

| Collection | Écran | Cadence | Contenu |
|---|---|---|---|
| `analytics_funnel` | Entonnoir | quotidienne | vus → admis → déclenchés → alertés, taux de conversion |
| `analytics_filter_perf` | Performance des filtres | hebdo | efficacité par filtre, balayages de seuil, matrice de redondance |
| `analytics_wallets` | Wallets | quotidienne | classements alpha et toxiques pré-triés |
| `analytics_deployers` | Déployeurs | quotidienne | table de réputation + graphe de clusters |
| `analytics_blindspots` | Angles morts | hebdo | ventilation du top 50, trous de couverture, latence |
| `analytics_discovery` | Découverte | hebdo | métriques classées par pouvoir discriminant, distributions |
| `analytics_regime` | Entonnoir | quotidienne | régime de marché, efficacité conditionnelle |
| `analytics_proposals` | Gouvernance | hebdo | propositions d'ajustement backtestées, en attente de validation |

Chaque document porte une `period` (`"2026-09-08"` ou `"2026-W36"`) et un `computed_at`.
Rétention : **illimitée** (quelques Ko par période).

---

# Rétention — vue d'ensemble

| Collection | Politique | Stationnaire |
|---|---|---|
| `tokens` | compaction à l'archivage (~2 Ko de résumé) | ~800 Mo |
| `token_metrics` | TTL 7 j | ~455 Mo |
| `token_metrics_hourly` | TTL 90 j | ~490 Mo |
| `token_metrics_daily` | illimitée | ~50 Mo/an |
| `positions` | purge conditionnelle 90 j | **~3–4 Go** |
| `trigger_snapshots` | illimitée | ~30 Mo/an |
| `outcomes` | illimitée | ~12 Mo/an |
| `alerts` | illimitée | négligeable |
| `rejected_seen` | TTL 30 j | ~150 Mo |
| `wallets` | recalculée, fenêtre 90 j | ~200 Mo |
| `deployers` / `clusters` | illimitée | ~50 Mo |
| `config_versions` | **jamais supprimée** | négligeable |
| `analytics_*` | illimitée | ~20 Mo/an |
| | **Total** | **~5 à 7 Go, stable** |

---

# Les 7 prérequis de la face 2 — où ils atterrissent

| # | Prérequis | Emplacement |
|---|---|---|
| 1 | `rejection_reason` structuré (filtre + **valeur** + seuil) | `trigger_snapshots.filters[]` |
| 2 | Les 100 premiers acheteurs, avec ts et MC à l'entrée | `positions` → figés dans `tokens.frozen_early_buyers` à la compaction |
| 3 | Déployeur **et** wallet financeur | `tokens.deployer` + `tokens.deployer_funder` |
| 4 | Détection et horodatage du rug | `outcomes.rugged` / `rug_ts` / `rug_type` |
| 5 | PnL par position reconstructible | `positions` (agrégé incrémentalement) |
| 6 | Les 9 métriques candidates de M6 | `trigger_snapshots.candidates` |
| 7 | Versionnage daté de la configuration | `config_versions` + `config_version` sur chaque token et chaque trigger |

---

# Trois pièges à ne pas oublier

1. **`positions` est le chemin d'écriture chaud** (~1,5 M upserts/jour). L'upsert doit se faire **par `_id`**, jamais par un filtre composite — sinon on paie un parcours d'index à chaque swap.
2. **`tokens` doit rester petit.** Il est réécrit toutes les 5 min pour les tokens `hot`. Rien de volumineux ni d'append-only dedans : les early buyers ne s'y déposent qu'à la compaction, quand le document cesse d'être chaud.
3. **`config_version` doit être estampillé sur chaque décision**, pas seulement dans `config_versions`. Sans ça, une analyse comparant deux périodes mélange des tokens jugés sous des règles différentes — et toutes les conclusions de la face 2 deviennent fausses.
