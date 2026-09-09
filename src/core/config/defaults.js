/**
 * Configuration v1 — valeurs de départ.
 *
 * AUCUNE de ces valeurs ne doit être codée en dur ailleurs dans le projet.
 * Un seuil en dur est un seuil que M5 ne pourra jamais optimiser.
 *
 * Les seuils marqués [hypothèse] n'ont aucune base empirique : ils seront
 * remplacés par les balayages de M5 après ~3 semaines de collecte.
 */

export const CONFIG_V1 = {
  _id: 1,
  created_at: new Date(),
  created_by: 'manual',
  active: true,
  note: 'Configuration initiale. Seuils de départ à calibrer par M5.',

  features: {
    // Activées après validation de la couverture Pulse chaîne par chaîne (P2).
    chains: {
      'solana:solana': true,
      'evm:8453': true,      // Base
      'evm:1': false,        // Ethereum
      'evm:56': false,       // BNB Smart Chain
      'evm:42161': false,    // Arbitrum
      'evm:4663': false      // Robinhood Chain
    },
    alerts:         { enabled: false },   // ← mode calibration : on évalue, on n'envoie pas
    second_chance:  { enabled: true },
    watchdog:       { enabled: true },
    social_scoring: { enabled: false },   // activé au seuil 5M seulement
    swap_collector: { enabled: true }     // P7
  },

  thresholds: {
    admission: {
      min_liquidity_usd: 5000,
      min_tx_15m: 30,
      min_wallets_15m: 20,
      second_chance_days: 7,
      // Fenetre de patience de la phase B, bornee par la FENETRE PULSE et non
      // par un delai arbitraire : au-dela, plus aucune donnee fraiche n'arrive.
      activity_window_hours: 3,
      activity_retry_minutes: 30,
      max_toxic_buyers: 2
    },

    // Synchronisation du webhook Helius.
    //
    // Chaque mise a jour coute 100 credits Helius, quel que soit le nombre
    // d adresses envoyees. Le cout ne depend donc que de la CADENCE :
    //   30 min -> 48 mises a jour/jour -> 4 800 credits/jour
    //   60 min -> 24                   -> 2 400
    //
    // L autre bout du compromis : une adresse enregistree en retard fait
    // perdre les premiers acheteurs du token, c est-a-dire exactement ce que
    // M2 cherche. Trop espacer revient a collecter pour rien.
    collector: {
      sync_interval_min: 30,
      // En deca, on attend : payer 100 credits pour deux adresses est un
      // mauvais echange, sauf si elles patientent depuis longtemps.
      min_new_addresses: 20,
      max_wait_min: 120
    },

    trigger: [150_000, 500_000, 1_000_000, 5_000_000],

    filters: {
      sell_pressure: 1.2,     // [hypothèse] buys/sells minimum
      wash_index: 8,          // [hypothèse] trades/traders maximum
      top_holders: 30,        // % max du top 10 hors pools
      lp_secured: 95          // % min de LP burnée
    },

    alert: {
      min_score: 70,
      cooldown_hours: 72,
      // Au-dela, le franchissement est trop ancien pour etre actionnable.
      max_age_minutes: 30,
      max_per_hour: 6
    }
  },

  // Poids du score final — [hypothèse], à remplacer par régression (M5)
  weights: {
    velocity: 0.40,
    flow: 0.20,
    security: 0.20,
    social: 0.10,
    deployer: 0.10
  },

  // Cadence de vérification par tier, en minutes
  tiers: {
    hot: 5,
    warm: 30,
    cold: 360,
    hot_mc_floor: 80_000,        // MC au-delà de laquelle un token est hot d'office
    warm_activity_hours: 6,
    cold_inactivity_hours: 24,
    archive_inactivity_hours: 72,
    archive_mc_ceiling: 20_000,

    // Modulation sociale du tier — fonde sur arxiv 2607.02823 (832 941
    // lancements pump.fun) : Telegram HR 5,40, les trois reseaux x17,4.
    // On RALENTIT les tokens sans reseaux, on ne les rejette jamais.
    social_gating: {
      // Desactivee : couverture du champ socials de 7% a 84% selon le launchpad.
      // Le signal existe (Telegram HR 5.40) mais la donnee n est pas uniforme.
      enabled: false,
      no_social_max_tier: 'warm',
      mc_exempt: 30_000        // au-dela, le capital engage prime
    }
  },

  // Suivi d'outcome, en heures après déclenchement
  outcome_checkpoints: [1, 6, 24, 168],

  outcome: {
    success_multiple: 5,           // >= x5 sans rug = SUCCESS
    alive_liquidity_usd: 10_000,   // en dessous, le token est considere mort
    // Fenetre pendant laquelle un pool de remplacement transforme un
    // effondrement de liquidite en MIGRATION plutot qu'en rug.
    migration_window_minutes: 60
  },

  sources: {
    primary: 'mobula',
    // Repli pour les pools et la liquidité : token/markets de Mobula est instable
    // (25, 16, 3, 4 puis 0 pools sur des appels identiques). Gratuit, sans clé.
    secondary: 'dexscreener',
    // Budget quotidien ALIGNE sur le plan Mobula reellement souscrit.
    // Quotas mensuels : gratuit 10 000, Demarrer 125 000, Croissance 1 250 000.
    // Le limiteur refuse les appels au-dela — mieux vaut un pipeline qui
    // ralentit qu un pipeline qui martele une API qui le rejette.
    plan: 'starter',              // free | starter | growth
    daily_budget: 3800,           // 114 000/mois : 91 % du plan Demarrer
    batch_size: 50,              // mesuré au POC : 50 tokens pour 1 crédit
    discovery_interval_min: 5,
    // Pagination adaptative : mesure, le bucket plafonne a 50 items et Solana
    // voit naitre ~110 tokens/5min. Sans pagination on en perdait la moitie.
    // Voie POST : 10 vues pour 1 credit, filtrage cote serveur.
    discovery_use_post: true,
    discovery_post_pages: 1,
    // Plancher serveur VOLONTAIREMENT bas : filtrer au seuil d admission (5000)
    // nous rendrait aveugles a ce qu on ecarte, et priverait M5 de son balayage.
    discovery_server_liquidity_floor: 500,
    discovery_max_pages: 4,
    discovery_fresh_minutes: 10,
    liquidity_profile_ratio: 0.5,   // profil complet a partir de 50% du 1er seuil
    pulse_merge_cycles: 3        // buckets parfois vides → fusion sur N cycles
  },

  diff_from_previous: []
}
