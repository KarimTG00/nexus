# Face 1 — Le pipeline temps réel : vue d'ensemble

> Face 1 = pipeline temps réel (découverte → filtres → Telegram)
> Face 2 = boucle analytique (voir face2-modules.md)

## Vocabulaire

- **tier** = fréquence de surveillance d'un token (hot / warm / cold / archived)
- **seuil** = niveau de market cap qui déclenche l'analyse complète (150K, 500K, 1M, 5M)

## Machine à états

```
discovered → pending_activity (15 min) → rejected | tracked
tracked → triggered → alerted | quarantine
quarantine → tracked (défaut corrigé) | archived
```

Rien n'est supprimé : `rejected` et `quarantine` sont la matière première de la face 2.

## Modèle : un token, N pools

Un token est un contrat ; un **pool** est un *autre* contrat, qui porte le prix et la liquidité. Un token peut avoir plusieurs pools, et sa liquidité peut migrer ou se fragmenter. **On ne suit jamais « le » pool d'un token — on suit un token qui possède un ensemble de pools.**

```
token: {
  address, chain, deployer,
  pools: [ { address, dex, quote, created_at, liquidity, active } ],
  primary_pool: <adresse du pool le plus profond>
}
```

**Les cinq cas de migration / fragmentation :**

| Cas | Description | Fréquence |
|---|---|---|
| **Graduation de launchpad** | bonding curve pump.fun → PumpSwap/Raydium, nouvelle adresse | **le plus fréquent, vers 60–70K de MC** |
| Version de DEX | Uniswap V2 → V3, Raydium AMM → CPMM/CLMM | courant |
| Actif de cotation | TOKEN/WETH → TOKEN/USDC | occasionnel |
| **Fragmentation** | la liquidité ne part pas, elle **se divise** sur plusieurs pools | le plus vicieux |
| Redéploiement | liquidité retirée et relancée ailleurs | rare |

**Pourquoi c'est critique :** si la liquidité part d'un pool qu'on surveille seul, le bot voit volume → 0, prix figé, MC figé. Le token est classé `cold` puis `archived` pendant qu'il fait ×20 ailleurs. La graduation de launchpad tombe **juste avant** notre seuil de 150K : la rater, c'est rater le token au moment exact où il devient intéressant.

La fragmentation est le cas le plus pernicieux : le MC reste juste (l'arbitrage aligne les prix), donc rien n'a l'air cassé — mais **le flux de swaps est sous-compté**, donc score d'intérêt, traders uniques et équilibre achats/ventes sont tous faux, silencieusement.

**Le correctif ne coûte presque rien :** on est **déjà abonné** aux événements de création de pool à l'étage 0. Aujourd'hui, quand l'événement concerne un token déjà connu, on le jette comme doublon. Il suffit de ne plus le jeter.

**Heuristique de sécurité :** un token en tier `hot` qui tombe brutalement à zéro swap **alors que son dernier prix connu ne s'est pas effondré** → aller chercher s'il existe un nouveau pool.

---

## ÉTAGE 0 — Découverte

**Intérêt :** capter tout nouveau token, sur toutes les chaînes activées.

**Comment :**
- Deux sources volontairement redondantes : **Mobula** (couverture large multi-chain, cycle 5 min) + **écoute native** (temps réel, indépendante d'un tiers)
- Écoute native Solana : webhook Helius sur les créations de pool (Raydium, PumpSwap, Meteora)
- Écoute native EVM : `eth_subscribe` sur les events PairCreated / PoolCreated des factories (Uniswap V2/V3/V4, PancakeSwap, Aerodrome…) — un seul code, N chaînes par config
- Sortie : `{chain, token, pool, deployer, discovered_at}`, dédoublonné contre la base
- **Si le token est déjà en base → on n'ignore pas l'événement, on ajoute le pool à son ensemble `pools[]`.** C'est ce qui rattrape les graduations de launchpad et les fragmentations. Coût nul : l'événement arrive déjà
- Pour les launchpads connus, la migration est **prévisible** : la graduation pump.fun est une instruction identifiable, on l'écoute explicitement au lieu de la déduire
- Garder une trace légère des tokens déjà rejetés (TTL 7 j) pour ne pas les re-traiter en boucle

---

## ÉTAGE 1 — Admission (t=0, puis t+15 min)

**Intérêt :** transformer 35–50 000 tokens/jour en 300–600. C'est le filtre le plus discriminant en volume.

**Comment — phase A, immédiate**, du moins cher au plus cher, court-circuit au premier échec :

| # | Contrôle | Motif de rejet |
|---|---|---|
| 1 | Déjà en base ? | `duplicate` |
| 2 | Métadonnées : nom, ticker, supply, decimals, déployeur | — |
| 3 | Liquidité initiale ≥ 5 000 $ | `low_liquidity` |
| 4 | Déployeur / cluster blacklisté (M4) | `blacklisted_deployer` |
| 5 | ≥ 2 wallets toxiques parmi les 50 premiers acheteurs (M3) | `toxic_buyers` |
| 6 | Sécurité de base (adapter par chaîne) | `mint_authority` / `freeze_authority` / `honeypot` / `high_tax` |

**Adapters de sécurité** — seul endroit où EVM et Solana divergent vraiment :

| | Solana | EVM |
|---|---|---|
| Impression de jetons | `mintAuthority == null` | ownership renoncée ou pas de `mint()` |
| Blocage des vendeurs | `freezeAuthority == null` | pas de `blacklist()` / `pause()` |
| Piège à la vente | n/a | simulation honeypot + taxes < 5 % |
| Contrat modifiable | n/a | pas de proxy upgradeable |

💡 **Les contrôles 3, 4 et 5 sont servis par Pulse, sans appel supplémentaire.** Pulse fournit `liquidity`, `deployer`, `holders_count`, `top10HoldingsPercentage` et `devHoldingsPercentage` dans la réponse de découverte. **Seul le contrôle 6 (mint/freeze authority) reste un appel RPC** — et c'est le moins cher du système. `security` et `securityScore` de Mobula sont `null` sur les tokens frais : on ne peut pas s'y fier.

**Phase B, différée (t+15 min) :** ≥ 30 transactions et ≥ 20 wallets uniques. Lecture directe de `trades_15min` et `traders_15min` — **coût zéro si le token est encore dans un bucket Pulse**, 1 crédit sinon. Échec = `low_activity`. Succès = état `tracked`, tier `hot`.

**Seconde chance :** un token rejeté pour `low_liquidity` ou `low_activity` est revérifié **une fois par jour pendant 7 jours**. S'il franchit la barre entre-temps, il entre normalement. Récupère les tokens qui démarrent lentement.

---

## ÉTAGE 2 — Métriques de vélocité (Mobula)

**Intérêt :** mesurer la vitesse d'arrivée des acheteurs — le signal central de tout le bot.

⚠️ **Le flux de swaps a été retiré de la face 1** (décision du POC, voir `poc-mobula-rapport.md`). Mobula fournit déjà les métriques de vélocité agrégées. Le flux de swaps reste dans le projet, mais **au service exclusif de la face 2** — voir « Le collecteur de swaps » ci-dessous.

**Deux sources selon la maturité du token :**

| Source | Couvre | Coût | Fournit |
|---|---|---|---|
| **Pulse** (`/api/2/pulse`) | tokens récents : buckets `new`, `bonding`, `bonded` | 1 crédit / chaîne | 126 champs, dont vélocité, `holders_count`, `top10HoldingsPercentage`, `deployer` |
| **Token markets** (`/api/2/token/markets`) | **n'importe quel token**, par pool | 1 crédit / token | 138 champs par pool, dont vélocité et `liquidityBurnPercentage` |

**Les champs de vélocité, sur 8 fenêtres** (1min, 5min, 15min, 1h, 4h, 6h, 12h, 24h) :

```
buyers_*   sellers_*   traders_*        ← acheteurs / vendeurs / traders UNIQUES
buys_*     sells_*     trades_*
volume_buy_*   volume_sell_*
```

**Nos métriques, recalculées à partir de ces champs :**

```
score_interet(5min) = buyers_5min − sellers_5min
equilibre           = buys_5min / sells_5min
traders_uniques     = traders_5min
indice_wash         = trades_5min / traders_5min      (> 8 = suspect)
```

💡 **La pente se calcule en un seul appel.** Les fenêtres 1min / 5min / 15min / 1h sont dans la même réponse : l'accélération se lit en comparant les taux normalisés entre fenêtres, sans attendre trois relevés successifs. C'est plus rapide **et** moins cher que le design précédent.

On conserve malgré tout le flush 5 min vers `token_metrics` : la courbe historique reste nécessaire à M6 (analyse de la forme de la courbe de vélocité).

**Agrégation multi-pools :** `/api/2/token/markets` renvoie **tous** les pools avec leurs métriques individuelles. On somme sur les pools actifs — la fragmentation est traitée nativement.

---

### Le collecteur de swaps (face 2 uniquement)

Le flux de swaps ne sert plus la face 1, mais il reste **indispensable à M2, M3 et M4** : eux ont besoin de savoir *quels* wallets, ce qu'aucun agrégat ne donne.

⚠️ **Il doit tourner en continu dès que possible, même si M2/M3 ne sont pas encore écrits.** Un flux qu'on n'écoutait pas ne se rattrape jamais : les positions du mois dernier sont définitivement perdues. C'est la même classe de contrainte que le suivi d'outcome.

**Bonne nouvelle : en collecteur, il est bien plus simple qu'en portier.** Il n'a plus à porter l'état Redis de vélocité, les fenêtres glissantes, la promotion de tier ni le scoring temps réel. Il fait une seule chose :

```
swap reçu  →  upsert de la position (wallet, token)  →  jeté
```

Soit environ 20 % de la complexité du portier d'origine.

---

## ÉTAGE 3 — Tiers de surveillance & seuils

**Intérêt :** vérifier 4 000 tokens toutes les 5 min coûterait 1,15 M de requêtes/jour. Les tiers **combinés au lot** ramènent ça à ~3 100 crédits/jour.

💡 **Le lot change l'échelle.** `/api/1/market/multi-data?assets=a1,a2,…` accepte **50 tokens pour 1 seul crédit** (mesuré au POC). La surveillance du MC se fait donc par paquets de 50 :

```
sans lot ni tiers :  1 152 000 appels/jour
avec lot seul     :     23 040
avec lot + tiers  :      ~3 100   ← retenu
```

Les tiers restent nécessaires : le quota observé est de 10 000 crédits et **sa période est inconnue**. Avec le lot seul on serait à 23 000/jour, potentiellement au-dessus.

⚠️ **`multi-data` ne contient aucun champ de vélocité** (28 champs : prix, MC, volume, liquidité). Il sert uniquement à détecter le franchissement de seuil. La vélocité vient de Pulse ou de `token/markets`, appelés bien plus rarement.

**Comment :**

| Tier | Critère | Vérif MC | Population |
|---|---|---|---|
| `hot` | score positif **ou** MC > 80K | 5 min | ~300 |
| `warm` | a tradé dans les 6 h | 30 min | ~1 200 |
| `cold` | 0 volume depuis 24 h | 6 h | ~2 500 |
| `archived` | 0 volume 72 h **et** MC < 20K | arrêt | ∞ |

- **Le flux de swaps promeut, le janitor rétrograde.** Un token cold qui reçoit 40 swaps repasse hot en quelques secondes, sans attendre son cycle
- Janitor toutes les 15 min : reclassement + compaction des tokens morts (série temporelle écrasée, document résumé ~2 Ko conservé pour la face 2)
- MC recalculé localement (`supply × prix du pool le plus profond`) quand possible — gratuit et plus frais
- Le `primary_pool` est réévalué à chaque cycle : si un pool secondaire devient plus profond, il devient le pool de référence

**Seuils de déclenchement** (à ne pas confondre avec les tiers) :

```
150K → profil "ignition"      : vélocité + sécurité de base
500K → profil "confirmation"  : + durabilité du flux
1M   → profil "confirmation"
5M   → profil "maturité"      : + social + transparence IA + KOL
```

---

## ÉTAGE 4 — Déclenchement

**Intérêt :** figer le contexte exact au moment de la décision, pour que la face 2 puisse la rejouer plus tard.

**Comment :**
- Verrou : **un seul déclenchement par token et par seuil**
- Snapshot immédiat : score d'intérêt, pente, équilibre, traders uniques, liquidité, âge, MC exact, timestamp, + les 9 métriques candidates de M6
- Sans ce snapshot, l'analyse a posteriori est impossible

---

## ÉTAGE 5 — Analyse approfondie

**Intérêt :** ne tourne que sur les 20–60 déclenchements/jour. Du gratuit vers le payant, court-circuit au premier échec.

**Un seul appel `/api/2/token/markets` (1 crédit) fournit la quasi-totalité des contrôles :**

| Contrôle | Seuil de départ | Champ Mobula | Motif de rejet |
|---|---|---|---|
| Score d'intérêt | accélération positive entre fenêtres | `buyers_1/5/15min` | `flat_velocity` |
| Équilibre achats/ventes | ≥ 1,2 | `buys_5min / sells_5min` | `sell_pressure` |
| Anti-wash | trades / traders < 8 | `trades_5min / traders_5min` | `wash_trading` |
| Top 10 holders hors LP | < 30 % | `top10HoldingsPercentage` | `top_holders` |
| Liquidité | LP burnée ≥ 95 % **OU** lockée ≥ 6 mois **OU** protocolaire | `liquidityBurnPercentage` | `lp_not_secured` |

💡 Les cinq contrôles bloquants tiennent en **1 crédit**, contre plusieurs appels RPC et une API de sécurité dans le design précédent.

Le contrôle de liquidité porte sur le **pool dominant**, et signale en plus si la liquidité est fragmentée sur plusieurs pools (un LP burné à 100 % sur un pool qui ne porte que 30 % de la liquidité ne protège de rien).

L'exclusion des adresses (pools, burn, lockers, CEX) se fait via une liste maintenue par chaîne — principale source de faux positifs sur le calcul du top 10.

**Non bloquants — bonus de score :** attention sociale (followers X + vitesse, membres TG/Discord, boosts DexScreener), note de transparence IA, réputation du déployeur. À 150K ils renvoient souvent « données insuffisantes » : c'est normal, ils prennent leur sens aux seuils supérieurs.

**Tout rejet écrit un `rejection_reason` structuré** — `{filtre, valeur_mesurée, seuil, ts}` — et bascule le token en `quarantine`, jamais à la poubelle.

---

## ÉTAGE 6 — Score final

**Intérêt :** une note unique, déterministe et reproductible, pour décider d'alerter.

**Comment :**
- Chaque sous-score est normalisé par **rang percentile glissant sur 30 jours** — s'auto-adapte au régime de marché (en marché froid +40 peut valoir 90/100, en marché chaud +145 peut ne valoir que 60/100)
- Moyenne pondérée (valeurs de départ **arbitraires**, à remplacer par régression via M1+M5) :

```
score = 0.40 × vélocité
      + 0.20 × qualité du flux    (équilibre, traders uniques, anti-wash)
      + 0.20 × sécurité           (marge sur top10, qualité du LP)
      + 0.10 × attention sociale  (0 si absente, jamais pénalisant)
      + 0.10 × réputation déployeur
```

- Alerte si `score ≥ seuil` (configurable à chaud depuis Telegram)
- **L'IA n'intervient pas dans ce calcul.** Le scoring reste déterministe et auditable, sinon la face 2 ne peut plus rejouer les décisions passées

---

## ÉTAGE 7 — Message Telegram

**Intérêt :** livrer l'information. **Template pur, aucun appel LLM** — la structure est connue, un LLM n'apporterait que latence, coût et risque d'hallucination.

**Garde-fous :** cooldown 72 h par token et par seuil, plafond global (6 alertes/heure), mode pause manuel.

```
$TICKER — Solana · 2h04
150K MC franchi

Score d'intérêt   +145/5min   (hausse x3)
187 traders uniques · 312 achats / 28 ventes (11:1)
Liquidité 42K$ · LP burnée 100%
Mint OFF · Freeze OFF · Top10 21,4%
Déployeur : 3 lancements, 0 rug
Social 34/100 · Transparence C

Score 78/100
[DexScreener] [RugCheck] [Mute ce token]
```

Commandes : `/watchlist`, `/why <ticker>`, `/seuils`, `/pause`, `/stats`

---

## ÉTAGE 8 — Post-alerte (couture avec la face 2)

**Intérêt :** alimenter M1, le socle de toute la boucle analytique.

**Comment :**
- Statut `alerted`, tier maintenu `hot`
- Suivi d'outcome à **T+1h / T+6h / T+24h / T+7j** sur **tous les tokens déclenchés — alertés ET rejetés**
- C'est ce suivi qui permettra de dire « ton filtre top-holders t'a coûté 17 % de tes multiplicateurs »

⚠️ **Rug ≠ migration.** Vues depuis un seul pool, les deux sont identiques : la liquidité disparaît.

```
RUG        : LP retirée → aucun pool de remplacement
MIGRATION  : LP retirée → nouveau pool créé dans les 60 min, liquidité comparable ou supérieure
```

Confondre les deux **empoisonne toute la face 2** : M1 produit des verdicts faux, M3 classe comme « initiés » des traders honnêtes ayant vendu avant la migration, et M4 blackliste des déployeurs légitimes — blacklist qui agit ensuite **à t=0 sur l'admission**, donc l'erreur se propage et s'auto-entretient. Bug silencieux : rien ne plante, le système devient juste progressivement faux.

---

# Données & rétention

## La règle d'or

> **Un swap est un événement, pas une donnée. On ne stocke jamais l'événement — on stocke l'état qu'il met à jour.**

Un swap arrive, modifie quelques compteurs et une ligne de position, puis **il est jeté**. Il n'est jamais relu, jamais requêté, jamais scanné. On ne « ré-analyse » jamais les milliers de swaps d'un token.

## Pourquoi c'est possible

Aucun des 8 modules de la face 2 n'a besoin des swaps bruts. Tous travaillent sur des **agrégats** ou des **positions**.

## Le volume brut (ce qu'on évite)

| Tier | Tokens | Swaps/jour/token | Total |
|---|---|---|---|
| hot | 300 | ~3 000 | 900 000 |
| warm | 1 200 | ~200 | 240 000 |
| cold | 2 500 | ~5 | 12 500 |

→ **1,2 à 2 M de swaps/jour.** Stockés bruts : 600 Mo/jour = **216 Go/an, en croissance perpétuelle.** Intenable.

## Les trois couches

**Couche 1 — Le flux (éphémère, 0 octet).** Les swaps mettent à jour Redis et disparaissent.

**Couche 2 — Agrégats 5 min (Mongo time-series, ~150 o/doc).** Un document par token et par tranche de 5 min, uniquement si le token a tradé. ~65 Mo/jour, puis dégradation par TTL : 5 min gardé 7 j → horaire 90 j → journalier au-delà. **État stationnaire ~1 Go.**

**Couche 3 — Positions (~250 o/doc).** Une ligne par couple `wallet × token`, mise à jour incrémentalement. Un wallet qui fait 40 swaps sur un token produit **1 document, pas 40**.

```
{ wallet, token, first_buy_ts, first_buy_mc, total_acheté, total_vendu,
  prix_entrée_moy, prix_sortie_moy, pnl, clôturée }
```

Purges : plancher de taille (positions < 50 $ = bruit) + fenêtre 90 j, sauf wallets déjà classés alpha ou toxiques. **État stationnaire ~3–4 Go.**

## Total

| Couche | Stationnaire |
|---|---|
| Flux | 0 |
| Agrégats 5 min | ~1 Go |
| Positions | ~3–4 Go |
| Tokens, snapshots, rejets, outcomes, early buyers | ~1 Go |
| **Total** | **~5 à 7 Go, stable** |

Contre 216 Go/an en stockage naïf : **facteur ~35**, et surtout **ça ne grossit plus indéfiniment**.

## Le coût de traitement

Chaque swap = 3 opérations O(1) : test d'appartenance Redis, incrément de compteurs, upsert de position (bufferisé). À 1,5 M swaps/jour = ~17 op/s en moyenne, pics à quelques centaines. Redis encaisse 100 000 op/s. **Ce n'est pas un point de tension.**

## Le vrai point de tension : la RAM Redis

Les ensembles `seen:{token}` en adresses complètes = ~700 Mo. Trois réglages cumulables : hash 8 octets au lieu de l'adresse (÷5), TTL sur les tokens inactifs > 6 h (reconstruits depuis Mongo s'ils se réveillent), HyperLogLog (12 Ko fixes) là où on ne veut qu'un compte sans test d'appartenance. → **~150 à 250 Mo.**

## Inventaire des flux, par face

**Face 1 — crédits Mobula/jour :**

| Source | Crédits/jour |
|---|---|
| Surveillance du MC (lot de 50 + tiers) | ~3 100 |
| Découverte Pulse (6 chaînes, 5 min) | ~1 730 |
| Analyse approfondie (`token/markets`) | ~60 |
| Contrôles mint/freeze (RPC, hors quota Mobula) | ~600 |
| **Total Mobula** | **~4 900** |

**Face 2 — le collecteur de swaps :**

| Source | Volume/jour |
|---|---|
| Swaps (webhooks Helius + logs EVM) | 1,2 – 2 M |

Le collecteur alimente uniquement `positions`, pour M2, M3 et M4. La règle d'or reste entière : **le swap est un événement, pas une donnée** — il met à jour une position puis disparaît.

Réserve : les swaps ne capturent pas les transferts simples. Écart marginal pour un memecoin, et `holders_count` de Mobula recale le compte absolu.

## Les trois règles à graver

1. **Aucune collection `swaps`.** Le swap n'existe qu'en mémoire, le temps de son traitement.
2. **Toute métrique doit être calculable de façon incrémentale**, en O(1) à l'arrivée d'un événement. Si elle exige de relire l'historique, on la reformule ou on l'abandonne.
3. **Toute collection persistante a une politique de rétention définie dès sa création** : TTL, agrégation, ou purge conditionnelle. Pas de collection sans date de péremption.

---

# Les 4 voies d'échappement (ce que M7 diagnostique)

La fréquence de découverte n'est presque jamais la cause. **La couverture l'est.** Passer de 5 min à 30 secondes ne change rien si le token se lance sur un DEX auquel on n'est pas abonné.

| Voie | Cause | Correctif |
|---|---|---|
| ① Rejeté à l'admission | seuils liquidité / activité trop hauts | desserrer un seuil (config) |
| ② Jamais découvert | chaîne non activée, DEX/launchpad non écouté, lacune ou retard d'indexation Mobula, mécanique de lancement non reconnue, relance d'un vieux token | intégration |
| ③ Jamais atteint 150K | MC mal calculé, mauvais pool surveillé, liquidité migrée vers un nouveau pool, franchissement raté entre 2 vérifs en tier cold | débogage |
| ④ Déclenché puis rejeté | un filtre a bloqué | domaine de M5, pas M7 |

**Watchdog (atténue ②) :** chaque jour, récupérer les meilleures performances du marché et **ingérer d'office** celles absentes de la base, sans critères d'admission. Pas d'alerte rétroactive, mais M2/M3/M4 récupèrent leurs early buyers, wallets d'initiés et déployeurs.

---

# Interfaces clientes

Deux interfaces, une par face, avec des rôles volontairement distincts.

## Interface face 1 — Bot Telegram (temps réel, push)

**Rôle :** recevoir l'alerte au moment où elle se produit, en mobilité. Format court, décision rapide.

Voir l'étage 7 pour le format du message et les commandes.

## Interface face 2 — Dashboard web (analyse, pull)

**Stack : React + Tailwind CSS + Vite**, déployé en Static Site sur Render (tier gratuit suffisant). Données servies par une API REST authentifiée.

**Rôle :** explorer les données analysées. Un tableau Telegram ne permet pas de lire une courbe de vélocité, une matrice de corrélation ou un balayage de seuil.

### Les 8 écrans, un par module

| Écran | Module | Contenu |
|---|---|---|
| **Entonnoir** | M8 | tokens vus → admis → déclenchés → alertés, avec les taux de conversion et le régime de marché courant |
| **Performance des filtres** | M5 | le tableau « filtre / rejets / % ayant fait ×5 / verdict », les courbes de balayage de seuil, la matrice de redondance |
| **Explorateur de tokens** | M1 | liste filtrable (statut, verdict, motif de rejet, outcome) + **fiche détaillée par token** : courbe de vélocité, courbe de MC, early buyers, filtres passés/échoués avec les valeurs mesurées |
| **Wallets** | M2 / M3 | classement des wallets alpha (précocité, taux de réussite, facteur de profit, sélectivité) et liste des wallets toxiques avec leur historique |
| **Déployeurs** | M4 | table de réputation + visualisation des clusters |
| **Angles morts** | M7 | ventilation hebdomadaire du top 50 du marché, trous de couverture, latence de détection |
| **Découverte de critères** | M6 | classement des métriques par pouvoir discriminant, distributions gagnants vs perdants |
| **Gouvernance** | M8 | propositions d'ajustement chiffrées et backtestées, à valider ou rejeter ; historique versionné de la configuration |

### Trois règles de conception

1. **Le dashboard ne calcule rien.** Il lit des collections d'agrégats **pré-calculées par les jobs de la face 2**. Une agrégation à la volée sur des millions de positions rendrait chaque page inutilisable. Si un écran a besoin d'un chiffre, ce chiffre est produit en batch et stocké.
2. **Lecture seule, sauf un seul chemin d'écriture** : la validation des propositions de l'écran Gouvernance. Tout le reste est consultatif.
3. **Accès protégé.** Le dashboard expose la liste des wallets alpha et des wallets toxiques — la donnée la plus précieuse du système, et impossible à racheter. Authentification obligatoire, jamais d'accès public.

### Le pont entre les deux interfaces

L'alerte Telegram porte un bouton **« Analyse détaillée »** qui ouvre directement la fiche du token dans le dashboard. La commande `/why <ticker>` pointe vers la même page. Telegram déclenche, le web explique.

**Note :** la validation des propositions de M8 passe du bot Telegram au dashboard — juger un ajustement de seuil demande de voir la courbe de balayage, ce qu'un message Telegram ne peut pas rendre.

---

# Infrastructure (Render)

| Processus | Type | Rôle |
|---|---|---|
| `worker-pipeline` | Background Worker | **Face 1 entière** — étages 0 à 8, scheduler interne |
| `worker-collector` | Background Worker | **Face 2** — collecteur de swaps, alimente `positions` |
| `worker-analytics` | Cron Job | **Face 2** — M1 à M8, jobs quotidiens et hebdomadaires |
| `web-api` | Web Service | Webhooks Helius + webhook Telegram + **API REST du dashboard** |
| `dashboard` | Static Site | React + Tailwind (tier gratuit) |
| Redis | Key Value | état du portier, compteurs, rate limits, verrous |
| MongoDB Atlas | externe | tokens, time-series, positions, rejets, outcomes, agrégats |

⚠️ Le tier gratuit des Web Services Render **se met en veille** — un scanner doit tourner sur un Background Worker. Compter ~7–15 $/mois. Un Static Site, lui, ne dort pas : le dashboard reste gratuit.

Le rate limiter est **partagé via Redis** : les deux workers puisent dans les mêmes quotas Mobula/Helius, sinon ils se marchent dessus et déclenchent des 429.

Les routes du dashboard et les routes de webhooks vivent dans le même service mais sous deux préfixes séparés : les webhooks doivent rester publics et rapides, l'API du dashboard doit être authentifiée.
