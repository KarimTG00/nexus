# Rapport POC Mobula

**Date :** 2026-09-08 · **Scripts :** `poc/mobula-poc{,2,3,4}.mjs` · **Données brutes :** `poc/out/findings*.json`

---

## Verdict

**Mobula tient ses promesses, et va au-delà.** Aucun point bloquant. Deux découvertes changent significativement l'architecture, dans le sens de la simplification.

| # | Question | Verdict |
|---|---|---|
| Q1 | Flux de nouveaux listings | ✅ **oui**, temps réel (secondes), 3 buckets |
| Q2 | Couverture des chaînes | ✅ **100 chaînes**, dont les 6 visées |
| Q3 | Nombre de holders | ✅ **oui**, `holders_count` inclus dans Pulse |
| Q4 | Métriques agrégées ou par pool | ✅ **agrégées** sur tous les pools |
| Q5 | Pools par token | ✅ **oui**, avec liquidité par pool |
| Q6 | **Requêtes par lot** | ✅ **50 tokens pour 1 crédit** |
| Q7 | Limites de débit | 🟡 10 000 crédits, **période inconnue** |

---

## Les réponses en détail

### Q1 — Le flux de listings

`GET /api/2/pulse?chainId=solana:solana` renvoie **trois buckets** :

```json
{ "new":     { "data": [...] },   // pools tout juste créés
  "bonding": { "data": [...] },   // sur la courbe de bonding
  "bonded":  { "data": [...] } }  // gradués vers un AMM réel
```

⚠️ **`chainId` est obligatoire** — sans lui la réponse est vide. Il faut donc une requête par chaîne.

**Fraîcheur excellente :** un token observé avec `created_at` à 13:50:13 alors que l'appel tournait à 13:50:5x — **quelques secondes de latence**.

💡 **Le bucket `bonded` est exactement l'événement de graduation** dont on craignait de rater la migration de pool. Mobula nous le sert directement.

🔴 **Instabilité constatée :** sur 3 appels identiques, la réponse a varié de 1 013 735 à 181 879 octets, avec `new` et `bonding` parfois **vides**. Il faut une logique de **réessai et de fusion sur plusieurs cycles**, jamais se fier à un appel unique. Le paramètre `poolTypes` semble sans effet (les 3 buckets reviennent toujours). Ne pas utiliser `compressed=false` : la réponse revient en binaire illisible.

### Q6 — Le lot : la meilleure nouvelle

`GET /api/1/market/multi-data?assets=a1,a2,…` — testé avec 50 adresses réelles distinctes :

| Demandé | Reçu | Coût | Latence |
|---|---|---|---|
| 10 | 10 | **1 crédit** | 1 737 ms |
| 25 | 25 | **1 crédit** | 572 ms |
| 50 | 50 | **1 crédit** | 815 ms |

**Un lot de 50 coûte le même crédit qu'un appel unitaire.** Impact sur l'étage 3 :

```
sans lot :  4 000 tokens × 288 cycles  = 1 152 000 appels/jour
avec lot :  4 000 / 50 × 288 cycles    =    23 040 appels/jour
```

### Q7 — Le quota, seule zone d'ombre

En-têtes observés : `x-ratelimit-limit: 10000`, `x-ratelimit-cost: 1`.
`x-ratelimit-remaining` est resté à **10000 après une centaine d'appels** — soit le compteur n'est pas actif, soit la fenêtre est courte et se réinitialise.

**La période reste inconnue**, et c'est elle qui détermine le budget :

| Budget avec **lot + tiers** | crédits/jour |
|---|---|
| Étage 3 — hot (300 tokens, 5 min) | 1 728 |
| Étage 3 — warm (1 200, 30 min) | 1 152 |
| Étage 3 — cold (2 500, 6 h) | 200 |
| Découverte Pulse (6 chaînes, 5 min) | 1 728 |
| Analyse approfondie + divers | ~500 |
| **Total** | **~5 300** |

→ Si la limite est **journalière**, on passe confortablement. **Sans les tiers**, on serait à ~23 000/jour : le système de tiers reste donc nécessaire — le lot le rend seulement confortable au lieu de tendu.

**À vérifier auprès de Mobula** : période du quota et tarif au-delà.

### Latence

535 ms par appel en séquentiel, 411 ms en parallèle (gain ×1,3 seulement — parallélisme peu payant côté serveur). Les 4 158 ms de la première passe étaient un artefact de démarrage à froid. Pulse est plus lourd : 0,5 à 7 s selon la taille de la réponse (jusqu'à 1 Mo).

### Justesse

Prix Mobula vs DexScreener : **0,02 % d'écart**. Liquidité Mobula 23,3 M vs 3,6 M sur le pool principal DexScreener → Mobula **agrège bien tous les pools**, ce qui règle une partie du problème de fragmentation.

---

## La découverte qui change tout : 126 champs par token

Chaque entrée Pulse porte **126 champs**. Extrait de ce qui nous concerne directement :

**Vélocité et flux — par fenêtre (1min, 5min, 15min, 1h, 4h, 6h, 12h, 24h) :**
```
buyers_*     sellers_*    traders_*      ← acheteurs / vendeurs / traders UNIQUES
buys_*       sells_*      trades_*
volume_buy_* volume_sell_*
```

**Structure de détention :**
```
holders_count
top10HoldingsPercentage      top50/100/200HoldingsPercentage
devHoldingsPercentage        insidersHoldingsPercentage
snipersHoldingsPercentage    bundlersHoldingsPercentage
proTradersHolding            holders_list
```

**Origine et réputation :**
```
deployer     deployerMigrations    source    sourceFactory
twitterReusesCount    socials    dexscreenerListed
bonded    bondingPercentage    bondingCurveAddress    pair
```

**Sécurité :** `security` et `securityScore` — **tous deux `null`** sur les tokens frais testés.

### Ce que ça implique

**① `buyers_5min` est un proxy direct de notre score d'intérêt.**
Pas identique — notre score compte les wallets *jamais vus*, `buyers_5min` compte les acheteurs *uniques sur la fenêtre* — mais très corrélé, et **gratuit**.

**② Le flux de swaps n'est plus nécessaire pour la face 1.**
C'est la conséquence majeure. Le portier (étage 2) servait à calculer vélocité, équilibre achats/ventes, traders uniques et indice de wash. **Pulse fournit les quatre.**

Le flux de swaps reste **indispensable pour la face 2** — M2 (wallets alpha), M3 (initiés), les positions et le PnL exigent de savoir *quels* wallets, ce que Pulse ne donne pas au niveau individuel.

→ **La face 1 peut être livrée sans le flux de swaps.** C'est une réduction de périmètre considérable pour la v1 : plus de webhooks Helius, plus d'abonnements EVM, plus d'état Redis lourd, plus de gestion de reconnexion.

**③ Mobula calcule déjà des signaux qui recoupent nos modules.**
`insidersHoldingsPercentage` (≈ M3), `proTradersHolding` (≈ M2), `deployerMigrations` (≈ M4), `bundlersHoldingsPercentage` (métrique candidate n°4).

⚠️ Leur méthodologie est **opaque**. On ne les adopte pas les yeux fermés : on les **enregistre comme métriques candidates** dans `trigger_snapshots.candidates`, et **M6 mesurera leur pouvoir discriminant**. Si `insidersHoldingsPercentage` prédit bien, on économise la construction de M3. Sinon, on construit la nôtre — transparente et propriétaire. **Mesurer, pas supposer.**

**④ La sécurité reste à notre charge.**
`security: null` sur les tokens frais. Les contrôles mint/freeze authority (Solana) et ownership/honeypot (EVM) restent des appels RPC de notre côté — de toute façon les moins chers du système.

---

## Corrections à apporter à la spec

| Document | Correction |
|---|---|
| `face1-pipeline.md` étage 0 | `chainId` obligatoire ; 3 buckets `new`/`bonding`/`bonded` ; réessai et fusion obligatoires (buckets parfois vides) ; le bucket `bonded` **est** l'événement de graduation |
| `face1-pipeline.md` étage 1 | liquidité, activité, top10, déployeur, holders : **tous fournis par Pulse** → beaucoup moins d'appels RPC. Seule la sécurité mint/freeze reste en RPC |
| `face1-pipeline.md` étage 2 | **facultatif en v1** (voir décision ci-dessous) |
| `face1-pipeline.md` étage 3 | lot de 50 → budget divisé par 50 ; tiers conservés |
| `face1-pipeline.md` étage 5 | `top10HoldingsPercentage` gratuit via Pulse |
| `data-model.md` | ajouter les champs Mobula aux `candidates` de `trigger_snapshots` |
| `architecture.md` | `DataSource.capabilities` doit déclarer `velocity_metrics` — le pipeline s'en sert si présent, sinon il retombe sur le flux de swaps |

---

## La décision à prendre

**Faut-il garder le flux de swaps (étage 2) en v1 ?**

| | Avec le flux dès la v1 | Sans le flux en v1 |
|---|---|---|
| Délai de livraison | plus long | **nettement plus court** |
| Complexité | webhooks, reconnexions, état Redis lourd | Pulse seul |
| Vélocité | wallets réellement nouveaux, temps réel | proxy `buyers_5min`, granularité 5 min |
| Face 2 — M2/M3 | disponibles | **impossibles tant que le flux n'existe pas** |
| Détection du wash | fine (swaps/traders) | grossière (`trades_*`/`traders_*`) |

**Ma recommandation :** livrer la v1 sans le flux de swaps, mais **écrire les positions dès qu'il arrive**. Concrètement :

1. **v1** — pipeline complet sur Pulse seul, mode calibration (`alerts.enabled: false`), M1 et M7 actifs. On accumule des `trigger_snapshots` et des `outcomes` dès le premier jour.
2. **v2** — ajout du flux de swaps, qui alimente `positions`, puis M2, M3 et M4.

L'ordre est bon : M1 et M7 ne demandent aucune donnée de wallet, et ce sont eux qui révèlent les plus gros défauts de calibration. Le flux de swaps arrive quand on en a réellement besoin — pour les modules de wallets.

---

## Ce qui reste à vérifier

1. **Période du quota** (jour ? minute ? mois ?) et tarifs au-delà — à demander à Mobula
2. **Plafond réel du lot** au-delà de 50 — testé jusqu'à 50 seulement, faute d'adresses distinctes
3. **Stabilité de Pulse dans la durée** — les buckets vides sont-ils passagers ou fréquents ? À mesurer sur 24 h
4. **Couverture EVM de Pulse** — testé sur Solana et Base ; à valider sur Ethereum, BNB, Arbitrum, Robinhood Chain
5. **`security` toujours nul ?** — vérifier sur des tokens plus matures
