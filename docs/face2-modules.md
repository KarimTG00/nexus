# Face 2 — La boucle analytique : vue d'ensemble

> Face 1 = pipeline temps reel (decouverte -> filtres -> Telegram)
> Face 2 = boucle analytique (apprend des donnees et corrige la face 1)

---

## M1 — Outcome & labellisation
**Le socle. Sans lui, aucun autre module n'existe.**

**Interet :** aujourd'hui tous les seuils sont des opinions. M1 attribue a chaque token un
verdict objectif et transforme ces opinions en faits mesurables.

**Comment :**
- Mesurer **tous** les tokens declenches — alertes ET rejetes — a T+1h, T+6h, T+24h, T+7j
- Enregistrer : MC max atteint, multiple vs MC de declenchement, temps jusqu'au pic,
  drawdown, encore vivant, a rug
- Detection mecanique du rug **avec horodatage** : LP retiree > 80 %, ou liquidite < 10 % du
  pic, ou dev vendant > 30 % de la supply en < 10 min
- Verdict final a J+7 : SUCCESS (>=5x sans rug) / SURVIVED / DEAD / RUGGED

---

## M2 — Wallets alpha

**Interet :** identifier les wallets dont l'ACHAT est un indicateur avance. Permet d'alerter
avant les 150K.

**Comment :**
- Reconstruction du PnL par position fermee (>= 90 % revendu) a partir du flux de swaps
- 4 metriques par wallet : **precocite** (percentile du MC a l'entree — la plus importante),
  taux de reussite, facteur de profit, selectivite
- Garde-fous : minimum 15 positions fermees, classement sur borne basse de Wilson (elimine
  les chanceux), exclusion des bots (> 50 tokens/jour), regroupement des sybils par wallet
  financeur
- Fenetre glissante 90 jours avec ponderation de recence

**-> Face 1 :** >= 3 wallets alpha achetent en 30 min -> alerte anticipee.

---

## M3 — Wallets toxiques / inities
**Le filtre le plus rentable, et introuvable ailleurs.**

**Interet :** detecter les complices d'un rug AVANT que le rug arrive.

**Comment :**
- Sur chaque token RUGGED, lister les wallets sortis en profit dans les 60 min precedant le rug
- Signature d'un initie = **3 conditions cumulees** : entre dans les tout premiers acheteurs
  (< 2 min) + sorti en profit avant le rug + **repete sur >= 4 tokens**
- La 3e condition est ce qui separe l'initie du bon trader (qui, lui, entre plus tard)
- Effet de bord : un wallet initie sur des tokens de deployeurs "differents" prouve que ces
  deployeurs sont le meme acteur -> nourrit M4

**-> Face 1 :** >= 2 wallets toxiques parmi les 50 premiers acheteurs -> rejet immediat a t=0.

---

## M4 — Deployeurs & clustering

**Interet :** un rugger recidive presque toujours — mais il change de wallet a chaque fois.
Tout l'enjeu est de le relier a ses identites passees.

**Comment :**
- Par deployeur, a partir des verdicts M1 : taux de rug, taux de survie, taux de succes,
  nombre de lancements
- **Clustering** pour relier les identites : wallet financeur commun (signal principal),
  similarite de bytecode sur EVM, empreinte des metadonnees, chevauchement des early buyers
  via M3
- Sur EVM, remonter au signataire reel quand le deploiement passe par une factory
- Regle : **jamais bloquant pour un deployeur inconnu** (c'est la majorite), uniquement
  bonus/malus

**-> Face 1 :** cluster avec >= 3 rugs -> blacklist dure a t=0.

---

## M5 — Calibration des filtres

**Interet :** savoir lesquels des filtres protegent et lesquels font rater de l'argent.

**Comment — 4 analyses :**
- **Efficacite** : taux de reussite des tokens rejetes par chaque filtre, compare au taux de
  base des alertes. Si les deux sont proches, le filtre ne discrimine rien.
- **Balayage de seuil** : rejouer chaque valeur candidate sur l'archive — possible uniquement
  parce qu'on a stocke la VALEUR MESUREE, pas juste un pass/fail
- **Redondance** : matrice de correlation des rejets ; deux filtres qui rejettent les memes
  tokens = un doublon payant des appels API pour rien
- **Ordre d'execution** : reordonner par (taux de rejet x cout) -> typiquement 30-50 %
  d'appels en moins

---

## M6 — Decouverte de nouveaux criteres

**Interet :** sortir des intuitions de depart et trouver des criteres non imagines.

**Comment :**
- **Analyse differentielle** : pour chaque metrique enregistree, comparer la distribution des
  gagnants et des perdants, calculer le pouvoir discriminant, classer. Toute metrique
  puissante NON ENCORE UTILISEE devient un filtre candidat.
- **Forme de la courbe de velocite** : regrouper les courbes des 2 premieres heures par
  similarite et voir quels groupes contiennent les gagnants (hypothese a tester : une montee
  reguliere predit mieux qu'un pic unique)
- **Test du seuil 150K lui-meme** : rejouer l'archive a 80K / 150K / 300K / 500K
- /!\ **Prerequis** : instrumenter des la v1 les 9 metriques candidates meme inutilisees
  (liquidite/MC, age des wallets acheteurs, detection de bundle, temps pour atteindre 50K...)
  — elles ne sont pas reconstructibles a posteriori

---

## M7 — Angles morts

**Interet :** tous les autres modules ne voient que ce qui est en base. M7 voit CE QUE LE BOT
N'A JAMAIS VU — la plus grosse source d'echec, invisible autrement.

**Comment :**
- Chaque semaine, recuperer les 50 meilleures performances du marche depuis une source externe
- Pour chacune, interroger la base : l'a-t-on vue ? a quel etage est-elle morte ?
- Repartition obtenue : alertes / rejetes par un filtre / jamais atteint 150K / rejetes a
  l'admission / **jamais decouverts**
- La derniere ligne revele les trous de couverture (chaine, DEX, source de listing) — aucune
  optimisation de seuil ne les corrigera
- En complement : **latence** — a quel MC on alerte par rapport au point d'entree optimal

---

## M8 — Regime de marche & gouvernance

**Interet :** un seuil optimal en marche froid ne l'est plus en marche euphorique. Et il faut
un garde-fou pour que le systeme ne derive pas tout seul.

**Comment :**
- Mesurer le regime : nombre de tokens franchissant 150K vs moyenne 30 jours, equilibre
  achats/ventes global du marche
- Mesurer l'efficacite de chaque filtre PAR REGIME et PAR CHAINE -> seuils conditionnels
  plutot que valeurs uniques
- Rapport hebdomadaire avec propositions chiffrees et backtestees, VALIDEES DEPUIS TELEGRAM
  — jamais d'auto-application
- Toute configuration **versionnee et datee**, pour savoir sous quelles regles chaque token a
  ete juge

---

# Le collecteur de swaps

Suite au POC Mobula, le flux de swaps a été **retiré de la face 1** : Mobula fournit déjà les
métriques de vélocité agrégées. Le flux devient un composant **exclusif de la face 2**.

**Qui en a besoin :** M2 (wallets alpha), M3 (initiés), M4 (chevauchement des early buyers).
Eux seuls ont besoin de savoir *quels* wallets — aucun agrégat ne le donne.

**Ce qu'il fait, et rien de plus :**

```
swap recu  ->  upsert de la position (wallet, token)  ->  jete
```

Plus d'etat Redis de velocite, plus de fenetres glissantes, plus de promotion de tier,
plus de scoring temps reel : environ 20 % de la complexite du "portier" d'origine.

/!\ **Il doit tourner en continu des que possible, meme si M2/M3 ne sont pas encore ecrits.**
Un flux qu'on n'ecoutait pas ne se rattrape jamais : les positions du mois dernier sont
definitivement perdues. Meme classe de contrainte que le suivi d'outcome (M1).

---

# Ordre de mise en oeuvre

M1 (jour 1) -> M7 (simple, revele les plus gros trous) -> M3 (le plus rentable) -> M5
-> M2 et M4 -> M6 quand le volume sera suffisant

# Les 7 prerequis a figer dans la face 1

1. `rejection_reason` structure : filtre + VALEUR MESUREE + seuil + horodatage
2. Les **100 premiers acheteurs** par token, avec horodatage et MC a l'entree
3. `deployer_address` ET wallet financeur
4. Detection et horodatage du `rug_event`
5. Journal des swaps par wallet suffisant pour reconstruire un PnL par position
6. Les 9 metriques candidates de M6, enregistrees meme si inutilisees
7. Versionnage date de la configuration
