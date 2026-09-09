# Architecture & évolutivité

> Voir `face1-pipeline.md`, `face2-modules.md`, `data-model.md`

## Le principe directeur

> **La flexibilité vient de petits modules uniformes, d'interfaces stables et de la configuration — jamais de moteurs génériques.**

On place la souplesse là où le changement est **certain**, et on assume la rigidité ailleurs. Une abstraction écrite « au cas où » est presque toujours fausse, parce qu'elle est bâtie sur un cas imaginaire.

## Les axes de changement, classés

| Ce qui va changer | Fréquence | Mécanisme |
|---|---|---|
| Seuils et pondérations | permanente | `config_versions` |
| Filtres (ajout / retrait) | **forte** — M6 en découvre | registre de filtres |
| Métriques candidates (9 → 25+) | **forte** | registre de métriques |
| Source de données (Mobula ?) | **risque ouvert** | interface `DataSource` |
| DEX / launchpads | **forte** | registre de DEX |
| Chaînes | moyenne | `ChainAdapter` |
| Écrans du dashboard | moyenne | collections `analytics_*` |
| Formule de score | faible mais critique | déclarative + versionnée |

---

# 1. Les registres (plugin pattern)

## Registre de filtres

Un filtre est **un fichier qui se déclare lui-même**. Le pipeline les découvre au démarrage, les trie, les évalue et enregistre le résultat. **Ajouter un filtre = déposer un fichier.** Aucune ligne de pipeline à modifier.

```js
// src/pipeline/filters/top_holders.js
export default {
  name: 'top_holders',
  stage: 'deep',                 // 'admission' | 'deep'
  blocking: true,                // false = simple bonus de score
  cost: 'paid',                  // 'free' | 'paid' → pilote l'ordre d'exécution
  configKey: 'thresholds.filters.top_holders',
  requires: ['holders'],         // pilote ce qu'on va chercher : on ne récupère
                                 // les holders que si un filtre actif en a besoin
  enabled: true,

  async evaluate(ctx, threshold) {
    const value = ctx.top10PctExcludingPools
    return { value, passed: value < threshold }
  }
}
```

Le moteur :

```js
const filters = loadFilters()                    // auto-découverte du dossier
  .filter(f => f.enabled && f.stage === stage)
  .sort(byCostThenRejectionRate)                 // ordre optimal, piloté par M5

for (const f of filters) {
  const { value, passed } = await f.evaluate(ctx, cfg.get(f.configKey))
  results.push({ name: f.name, value, threshold: cfg.get(f.configKey), passed })
  if (!passed && f.blocking) break               // court-circuit
}
```

✅ **Aucune migration de schéma nécessaire** : `trigger_snapshots.filters[]` est déjà un tableau d'objets, pas des colonnes fixes.

✅ **L'ordre d'exécution est piloté par la donnée** : M5 mesure le taux de rejet de chaque filtre, le moteur trie par `coût × taux de rejet`. Réordonner ne demande aucun code.

## Registre de métriques candidates

Même principe pour les métriques de M6, qui vont passer de 9 à 25.

```js
// src/pipeline/metrics/liq_mc_ratio.js
export default {
  name: 'liq_mc_ratio',
  since: 'v1',                   // depuis quelle version elle existe
  compute: ctx => ctx.liquidityUsd / ctx.mc
}
```

⚠️ **Règle d'implémentation critique :** l'analyse différentielle de M6 doit **découvrir la liste des métriques depuis les documents eux-mêmes** (`Object.keys(snapshot.candidates)`), jamais depuis une constante. Sinon chaque nouvelle métrique oblige à modifier l'analyse — exactement ce qu'on cherche à éviter.

Conséquence : M6 doit gérer les métriques **absentes** des anciens documents (une métrique ajoutée en v12 n'existe pas dans les snapshots v7). L'analyse se fait sur la population où la métrique est présente, en indiquant l'effectif.

## Registre de DEX

```js
// src/adapters/dexes/uniswap_v2.js
export default {
  name: 'uniswap_v2',
  chainFamily: 'evm',
  factories: { ethereum: '0x5C69...', base: '0x8909...' },
  poolCreatedEvent: 'PairCreated(address,address,address,uint256)',
  parsePoolCreated: log => ({ ... }),
  readReserves: async pool => ({ ... }),
  isLpBurned: async pool => ({ ... })
}
```

Un nouveau launchpad apparaît → un fichier. Il est actif dès le redémarrage.

---

# 2. Les interfaces (adapters)

## `DataSource` — la plus importante

**Le code n'appelle jamais Mobula directement.** Tout passe par l'interface. Si le POC déçoit, on écrit une seconde implémentation et on change une ligne de configuration — au lieu de réécrire le pipeline.

```js
export interface DataSource {
  getNewListings(since: Date, chains: string[]): Promise<TokenRef[]>
  getMarketData(tokens: TokenRef[]): Promise<MarketData[]>   // batch obligatoire
  getPools(token: TokenRef): Promise<Pool[]> | null          // null si non supporté
  getHolderCount(token: TokenRef): Promise<number> | null
  getTopGainers(period: string, limit: number): Promise<TokenRef[]>
  readonly capabilities: Set<Capability>                     // ← déclaratif
}
```

⚠️ **`capabilities` est le point clé.** Chaque source déclare ce qu'elle sait faire. Le pipeline s'adapte au lieu de planter :

```js
if (!source.capabilities.has('holder_count')) {
  // on se rabat sur le flux de swaps, et on marque la métrique absente
}
```

Ça permet aussi de **composer plusieurs sources** : Mobula pour les listings, DexScreener pour les pools, Birdeye pour les holders — sans que le pipeline sache lequel fait quoi.

## `ChainAdapter`

```js
export interface ChainAdapter {
  readonly family: 'evm' | 'solana'
  checkBaseSecurity(token): Promise<{ passed, reason, details }>
  parseSwapEvent(raw): Swap | null
  resolveDeployer(token): Promise<{ deployer, funder }>
  normalizeAddress(addr): string
  isExcludedAddress(addr): boolean        // pools, burn, lockers, CEX
}
```

⚠️ **On construit cette interface à partir des deux cas réels (EVM, Solana), pas d'une blockchain imaginaire.** On la généralisera au troisième cas si un jour il ne rentre pas — pas avant.

## `Notifier`

Aujourd'hui Telegram. Demain peut-être Discord, un webhook, un e-mail.

```js
export interface Notifier {
  send(alert: Alert): Promise<{ messageId }>
  supportsButtons: boolean
}
```

---

# 3. Configuration

## Une seule source de vérité, versionnée

Toute valeur ajustable vit dans `config_versions` (voir `data-model.md`). **Aucune constante en dur dans le code.** Un seuil codé en dur est un seuil que M5 ne pourra jamais optimiser.

```js
const cfg = await ConfigStore.active()     // cache Redis, invalidé sur changement
cfg.get('thresholds.filters.top_holders')  // 30
```

## Rechargement à chaud

Un changement de config crée une **nouvelle version** et invalide le cache. Les workers rechargent sans redémarrage. Toute décision prise ensuite porte le nouveau `config_version`.

## Les feature flags

```js
{
  features: {
    chains:        { solana: true, ethereum: true, base: true, bnb: true, arbitrum: false },
    alerts:        { enabled: false },         // ← mode calibration : on évalue, on n'envoie pas
    second_chance: { enabled: true },
    watchdog:      { enabled: true },
    social_scoring:{ enabled: false }          // activé au seuil 5M seulement
  }
}
```

💡 `alerts.enabled: false` **est** le mode calibration : le pipeline tourne entièrement, écrit tous les `trigger_snapshots`, mais n'envoie rien. Pas de code spécial à écrire.

---

# 4. Le schéma Mongo : souple par défaut, strict aux points chauds

Mongo est sans schéma — flexibilité gratuite. Mais liberté totale = corruption silencieuse. Le dosage :

| Zone | Politique |
|---|---|
| `candidates`, `filters[]`, `analytics_*`, `subscores` | **aucun validateur** — doivent accepter de nouvelles clés sans migration |
| `tokens`, `positions`, `outcomes` (noyau) | **validateur** sur le format d'`_id`, les enums (`status`, `tier`, `verdict`) et les champs requis |
| Partout | **`schema_version`** sur chaque document |

Une faute de frappe dans un enum de `status` casserait le pipeline sans aucune alarme. Un validateur là est de la robustesse, pas de la rigidité.

## Migrations : additives uniquement

**Jamais renommer, jamais réaffecter un champ.** On ajoute, on déprécie, on remplit progressivement.

C'est une règle **dure** ici, parce que certaines collections sont **irremplaçables** :

| Collection | Recalculable ? |
|---|---|
| `token_metrics` | non, mais dégradable sans dommage |
| `positions` | non |
| **`trigger_snapshots`** | **jamais** — c'est la vérité terrain de chaque décision |
| **`outcomes`** | **jamais** — le passé du marché ne se rejoue pas |
| `wallets`, `deployers`, `analytics_*` | oui, recalculées à chaque batch |

Les deux collections en gras sont des **registres en append-only**. Aucune migration destructive n'y est autorisée, jamais. On y ajoute des champs, on n'en retire ni n'en renomme.

---

# 5. Structure du code

```
src/
  core/
    config/          # ConfigStore, versionnage, rechargement à chaud
    types/           # interfaces partagées
    db/              # connexion Mongo, index, validateurs
    cache/           # Redis, rate limiter partagé
    logger/

  adapters/
    chains/          # solana.js, evm.js           → ChainAdapter
    sources/         # mobula.js, dexscreener.js   → DataSource
    dexes/           # raydium.js, uniswap_v2.js   → registre
    notifiers/       # telegram.js                 → Notifier

  pipeline/
    stages/          # 0-discovery … 8-outcome, un fichier par étage
    filters/         # un fichier par filtre — auto-découvert
    metrics/         # un fichier par métrique candidate — auto-découvert
    scoring/         # formule déclarative

  analytics/         # m1-outcome.js … m8-governance.js, un module par module

  api/               # REST du dashboard (authentifiée)
  webhooks/          # Helius, Telegram (publiques)
  bot/               # commandes Telegram

  workers/
    stream.js        # étage 2
    pipeline.js      # étages 0,1,3,4,5,6,7
    analytics.js     # face 2
```

**Règle de dépendance :** `pipeline/` et `analytics/` ne connaissent que les **interfaces** de `core/types`. Ils n'importent jamais un adapter concret. C'est ce qui rend une source remplaçable.

---

# 6. Le scoring : déclaratif, jamais codé en dur

```js
function score(subscores, weights) {
  const active = Object.keys(weights).filter(k => k in subscores)
  const total  = active.reduce((s, k) => s + weights[k], 0)
  return active.reduce((s, k) => s + subscores[k] * weights[k], 0) / total   // renormalisé
}
```

Deux propriétés qui comptent :
- **Ajouter un sous-score** = un collecteur + une ligne de config. La formule ne bouge pas.
- **Renormalisation automatique** : si un sous-score est absent (social indisponible à 150K), les poids restants sont renormalisés au lieu de pénaliser le token.

---

# 7. Où NE PAS être flexible

**① Ne pas abstraire ce qu'on n'a qu'en un exemplaire.**
Deux familles de chaînes, pas dix. Une abstraction « n'importe quelle blockchain » écrite aujourd'hui serait fausse de façons imprévisibles. On généralise **au troisième cas réel**, pas avant.

**② Pas de moteur de règles générique ni de DSL de filtres.**
Ça paraît être le sommet de la flexibilité. En pratique c'est un mini-langage intestable, sans typage, sans débogueur, que personne ne se rappelle six mois plus tard. Des modules JS avec une signature commune sont **plus souples dans les faits**.

**③ Le score doit rester déterministe et versionné.**
La flexibilité passe par `config_versions`, jamais par de l'improvisation à l'exécution. Un score qui varie sans trace rend impossible le rejeu des décisions passées — et toute la face 2 s'écroule avec.

**④ Pas de généricité sur le chemin chaud.**
`positions` reçoit ~1,5 M d'upserts/jour. Ce code-là est écrit une fois, en dur, optimisé. Une couche d'abstraction élégante y coûterait plus que tout ce qu'elle rapporterait.

**⑤ Pas de configuration pour ce qui ne changera pas.**
Chaque option ajoutée est un chemin de code à tester. Une option qui n'a jamais deux valeurs différentes est une dette, pas une souplesse.

---

# 8. Checklist avant d'ajouter quoi que ce soit

- [ ] Est-ce un **filtre** ? → un fichier dans `pipeline/filters/`, rien d'autre
- [ ] Est-ce une **métrique** ? → un fichier dans `pipeline/metrics/`, rien d'autre
- [ ] Est-ce un **DEX** ? → un fichier dans `adapters/dexes/`, rien d'autre
- [ ] Est-ce une **valeur ajustable** ? → dans `config_versions`, jamais en dur
- [ ] Est-ce un **champ de document** ? → additif, avec `schema_version`
- [ ] Est-ce sur **`trigger_snapshots` ou `outcomes`** ? → additif **uniquement**, jamais de renommage
- [ ] Est-ce une **abstraction** ? → ai-je **deux cas réels** sous les yeux ? Sinon, attendre
