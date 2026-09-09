# Feuille de route — de zéro au déploiement

> Voir `face1-pipeline.md`, `face2-modules.md`, `data-model.md`, `architecture.md`, `poc-mobula-rapport.md`

---

## Le principe d'ordonnancement

**Trois enregistreurs produisent des données qu'on ne peut jamais rattraper :**

| Enregistreur | Collection | Phase |
|---|---|---|
| Chaque décision et son contexte complet | `trigger_snapshots` | **P4** |
| Ce que le token est devenu | `outcomes` | **P6** |
| Qui a acheté quoi, et quand | `positions` | **P7** |

Un mois sans les faire tourner est un mois perdu **définitivement**. Le marché ne se rejoue pas.

Tout le reste — Telegram, dashboard, les huit modules d'analyse — peut être construit à n'importe quel moment, y compris six mois plus tard, et fonctionnera **rétroactivement** sur les données accumulées.

> **D'où l'ordre : mettre les enregistreurs en production le plus tôt possible, construire l'exploitation ensuite.**

Concrètement : on déploie en **mode calibration** (`alerts.enabled: false`) avant même d'écrire le bot Telegram et le dashboard. Le système collecte pendant qu'on continue à développer.

---

## P0 — Fondations · ~1-2 j

**Contenu**
- Squelette du projet selon `architecture.md` (`core/`, `adapters/`, `pipeline/`, `analytics/`, `workers/`)
- `package.json`, ESLint, scripts npm
- Connexion MongoDB : création des collections, index, validateurs sur le noyau
- Connexion Redis
- `ConfigStore` : chargement, cache, rechargement à chaud ; insertion de `config_versions` v1
- Logger structuré

**Validé quand** `npm run dev` démarre, se connecte aux deux bases et affiche la configuration active.

---

## P1 — Couche `DataSource` · ~2 j

**Contenu**
- Interface `DataSource` + `capabilities`
- `MobulaSource` : reprise et durcissement du code du POC
- Rate limiter partagé via Redis, back-off exponentiel sur 429
- **Fusion des buckets Pulse sur plusieurs cycles** — indispensable : le POC a constaté des buckets `new` et `bonding` vides de façon intermittente
- Normalisation vers nos types internes (ne jamais laisser fuiter la forme Mobula dans le pipeline)

**Validé quand** `getNewListings()`, `getMarketData()` en lot de 50 et `getTokenMarkets()` renvoient des données normalisées, et 100 appels d'affilée passent sans 429.

---

## P2 — Étages 0 et 1 : découverte et admission · ~3 j

**Contenu**
- Boucle de découverte Pulse, une requête par chaîne, toutes les 5 min
- Dédoublonnage contre `tokens` et `rejected_seen`
- Enrichissement de `pools[]` quand un pool concerne un token déjà connu
- Registre de filtres d'admission (auto-découverte du dossier)
- `ChainAdapter` Solana : mint / freeze authority via RPC Helius
- `rejected_seen` avec TTL 30 j + mécanisme de seconde chance

**Validé quand** des tokens entrent dans `tokens` au bon statut, et que l'entonnoir quotidien est cohérent : quelques dizaines de milliers vus, ~300-600 admis.

---

## P3 — Étage 3 : surveillance et tiers · ~2 j

**Contenu**
- Ordonnanceur fondé sur `next_check_at` (parcours d'index, pas de scan)
- Interrogation du MC par lots de 50 (`multi-data`)
- Janitor toutes les 15 min : promotion / rétrogradation de tier, archivage, compaction
- Écriture dans `token_metrics` (time-series) + rollups horaire et journalier
- Réévaluation du `primary_pool`

**Validé quand** un token suivi voit son MC évoluer en base et change de tier quand son activité change.

---

## P4 — Étages 4, 5, 6 : déclenchement, analyse, score · ~3 j

⚠️ **Premier enregistreur irremplaçable.**

**Contenu**
- Détection de franchissement de seuil, avec verrou par token et par seuil
- Registre de filtres profonds ; un seul appel `token/markets` couvre les 5 contrôles bloquants
- Registre de métriques candidates (les 9 + les champs Mobula à mesurer : `insidersHoldingsPercentage`, `proTradersHolding`, `bundlersHoldingsPercentage`, `deployerMigrations`)
- Écriture du `trigger_snapshot` complet, avec les **valeurs mesurées** de chaque filtre
- Normalisation des sous-scores par rang percentile glissant sur 30 j
- Scoring déclaratif avec renormalisation des poids absents

**Validé quand** un franchissement produit un `trigger_snapshot` complet et rejouable.

---

## P5 — Déploiement en calibration · ~2 j

**Contenu**
- Dockerfile, `render.yaml`
- MongoDB Atlas, Redis, variables d'environnement
- `worker-pipeline` en Background Worker, `web-api` en Web Service
- `alerts.enabled: false`
- Rapport d'entonnoir quotidien (simple log ou message Telegram brut)
- Supervision : alerte si le worker s'arrête ou si le quota Mobula sature

**Validé quand** ça tourne 24 h sans intervention.

> **Jalon central : à partir d'ici, le système accumule en continu pendant que le développement se poursuit.**

---

## P6 — Étage 8 et M1 : outcomes · ~2 j

⚠️ **Deuxième enregistreur irremplaçable.**

**Contenu**
- Job de relevé à T+1h / T+6h / T+24h / T+7j, sur **tous** les tokens déclenchés — alertés et rejetés
- Détection du rug, avec la distinction **rug ≠ migration** (pas de pool de remplacement dans les 60 min)
- Calcul des verdicts `SUCCESS` / `SURVIVED` / `DEAD` / `RUGGED`

**Validé quand** les `outcomes` se remplissent et que les premiers verdicts tombent à J+7.

---

## P7 — Collecteur de swaps · ~4 j

⚠️ **Troisième enregistreur irremplaçable.**

**Contenu**
- Webhooks Helius (Solana), abonnement aux logs de swap (EVM)
- Filtrage sur les tokens présents en base
- Upsert des `positions` **par `_id` composite** (chemin d'écriture le plus chaud du système)
- Purge conditionnelle à 90 j

**Validé quand** `positions` se remplit et qu'un PnL par position est reconstituable pour un wallet donné.

---

## P8 — Bot Telegram · ~2 j

**Contenu**
- Template de message (aucun appel LLM), boutons, lien vers le dashboard
- Commandes `/watchlist`, `/why`, `/seuils`, `/pause`, `/stats`
- Cooldown 72 h par token et par seuil, plafond horaire
- Bascule `alerts.enabled: true`

**Validé quand** une alerte réelle arrive, correctement formatée, et que le cooldown empêche le doublon.

---

## P9 — Analytics : M7 puis M5 · ~3 j

**M7 en premier** : simple à écrire, et il révèle les plus gros défauts (trous de couverture, seuils d'admission trop hauts, latence).

**Puis M5** quand il y a assez de `trigger_snapshots` associés à des outcomes : efficacité par filtre, balayage de seuil, redondance, ordre d'exécution.

**Validé quand** le rapport d'angles morts sort chaque semaine et que le tableau d'efficacité des filtres est lisible.

---

## P10 — Dashboard · ~5-7 j

**Contenu**
- API REST authentifiée sous un préfixe séparé des webhooks
- React + Tailwind + Vite, déployé en Static Site
- Écrans par ordre d'utilité : **Entonnoir** → **Explorateur de tokens** → **Performance des filtres** → les autres
- Lecture exclusive des collections `analytics_*` pré-calculées

**Validé quand** chaque écran charge sans agrégation à la volée, et que l'authentification est en place.

---

## P11 — M2, M3, M4 · ~5 j

Wallets alpha, wallets toxiques, réputation et clustering des déployeurs.

⚠️ **Ils ne peuvent pas produire de résultat fiable avant ~90 jours de collecte de `positions`.** Leur position en fin de parcours n'est pas un retard de développement : c'est le temps d'accumulation qui commande.

---

# Jalons

| Jalon | Phases | Effort cumulé |
|---|---|---|
| **Production en calibration** | P0 → P5 | **~15 j** |
| Système complet avec alertes | → P8 | ~25 j |
| Boucle analytique opérationnelle | → P10 | ~35 j |
| Modules de wallets | → P11 | ~40 j + 90 j de collecte |

Efforts en journées de travail concentré, à ajuster selon ton rythme.

---

# Ce qui reste à vérifier en cours de route

1. **Période du quota Mobula** (10 000 crédits — par jour, minute, mois ?) — à demander avant P5, ça conditionne le dimensionnement
2. **Stabilité de Pulse sur 24 h** — mesurable dès P1
3. **Couverture EVM de Pulse** — Ethereum, BNB, Arbitrum, Robinhood Chain, à valider en P2
4. **Plafond réel du lot au-delà de 50** — testable dès qu'on a assez d'adresses en base, en P3
5. **Les seuils de départ de l'étage 5** (pente, ratio achats/ventes ≥ 1,2, indice de wash < 8) sont des hypothèses — c'est M5 qui tranchera, à partir de P9
