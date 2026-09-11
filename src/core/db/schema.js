/**
 * Définition déclarative des collections — voir docs/data-model.md
 *
 * Politique de validation (docs/architecture.md) :
 *   - noyau stable (tokens, positions, outcomes) → validateur sur _id, enums, champs requis
 *   - zones évolutives (candidates, filters[], subscores, analytics_*) → AUCUN validateur,
 *     elles doivent accepter de nouvelles clés sans migration
 */

export const SCHEMA_VERSION = 1

const DAY = 86400

// --- enums partagés --------------------------------------------------------
export const STATUS = ['discovered', 'pending_activity', 'tracked', 'triggered',
                       'alerted', 'quarantine', 'archived']
export const TIER = ['hot', 'warm', 'cold', 'archived']
export const VERDICT = ['SUCCESS', 'SURVIVED', 'DEAD', 'RUGGED', 'PENDING']
export const CHAIN_FAMILY = ['solana', 'evm']

// ---------------------------------------------------------------------------

export const collections = [
  {
    name: 'tokens',
    indexes: [
      // Chemin chaud : "que dois-je vérifier maintenant ?" — parcours d'index, pas de scan
      { key: { status: 1, next_check_at: 1 }, name: 'ix_due' },
      { key: { status: 1, 'market.mc': -1 },  name: 'ix_status_mc' },
      { key: { deployer: 1 },                 name: 'ix_deployer' },
      { key: { 'pools.address': 1 },          name: 'ix_pool' },
      { key: { chain: 1, symbol: 1 },         name: 'ix_symbol' },
      { key: { tier: 1 },                     name: 'ix_tier' },
      { key: { symbol_norm: 1, discovered_at: -1 }, name: 'ix_burst' },
      { key: { asset_id: 1 },                 name: 'ix_asset' }
    ],
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'chain', 'address', 'status', 'schema_version'],
        properties: {
          _id:            { bsonType: 'string', pattern: '^[a-z0-9:]+:.+$' },
          chain:          { bsonType: 'string' },
          address:        { bsonType: 'string' },
          status:         { enum: STATUS },
          tier:           { enum: TIER },
          schema_version: { bsonType: 'int' }
        }
      }
    }
  },

  {
    name: 'token_metrics',
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' },
    expireAfterSeconds: 7 * DAY
  },
  {
    name: 'token_metrics_hourly',
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'hours' },
    expireAfterSeconds: 90 * DAY
  },
  {
    name: 'token_metrics_daily',
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'hours' }
    // conservation illimitée
  },

  {
    name: 'positions',
    indexes: [
      { key: { token: 1, first_buy_ts: 1 },              name: 'ix_early_buyers' },
      { key: { wallet: 1, closed: 1, closed_at: -1 },    name: 'ix_wallet_pnl' },
      { key: { token: 1, closed_at: 1 },                 name: 'ix_exits' },
      { key: { last_activity_ts: 1 },                    name: 'ix_purge' }
    ],
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'wallet', 'token', 'chain'],
        properties: {
          _id:    { bsonType: 'string' },
          wallet: { bsonType: 'string' },
          token:  { bsonType: 'string' },
          chain:  { bsonType: 'string' },
          closed: { bsonType: 'bool' }
        }
      }
    }
  },

  {
    // Registre append-only irremplaçable — jamais de migration destructive
    name: 'trigger_snapshots',
    indexes: [
      { key: { ts: -1 },                                     name: 'ix_ts' },
      { key: { decision: 1, ts: -1 },                        name: 'ix_decision' },
      { key: { token: 1 },                                   name: 'ix_token' },
      { key: { 'filters.name': 1, 'filters.passed': 1 },     name: 'ix_filters' },
      { key: { config_version: 1 },                          name: 'ix_config' }
    ]
    // pas de validateur : candidates{} et filters[] doivent rester libres
  },

  {
    // Registre append-only irremplaçable
    name: 'outcomes',
    indexes: [
      { key: { verdict: 1 },                name: 'ix_verdict' },
      { key: { multiple_max: -1 },          name: 'ix_multiple' },
      { key: { rugged: 1, rug_ts: 1 },      name: 'ix_rug' },
      { key: { next_checkpoint_at: 1 },     name: 'ix_due' }
    ],
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'token', 'threshold'],
        properties: {
          _id:     { bsonType: 'string' },
          token:   { bsonType: 'string' },
          verdict: { enum: VERDICT }
        }
      }
    }
  },

  {
    name: 'alerts',
    indexes: [
      { key: { token: 1, sent_at: -1 }, name: 'ix_cooldown' },
      { key: { sent_at: -1 },           name: 'ix_recent' }
    ]
  },

  {
    name: 'rejected_seen',
    indexes: [
      { key: { expires_at: 1 },   name: 'ix_ttl', expireAfterSeconds: 0 },
      { key: { next_retry_at: 1 }, name: 'ix_second_chance' },
      { key: { reason: 1 },        name: 'ix_reason' }
    ]
  },

  {
    name: 'wallets',
    indexes: [
      { key: { 'alpha.hit_rate_wilson_low': -1 }, name: 'ix_alpha' },
      { key: { 'toxic.flagged': 1 },              name: 'ix_toxic' },
      { key: { funder: 1 },                       name: 'ix_funder' }
    ]
  },

  {
    name: 'deployers',
    indexes: [
      { key: { cluster_id: 1 },  name: 'ix_cluster' },
      { key: { blacklisted: 1 }, name: 'ix_blacklist' },
      { key: { funder: 1 },      name: 'ix_funder' }
    ]
  },

  {
    name: 'clusters',
    indexes: [
      { key: { blacklisted: 1 }, name: 'ix_blacklist' },
      { key: { members: 1 },     name: 'ix_members' }
    ]
  },

  {
    // Jamais supprimée : sans elle, comparer deux périodes n'a aucun sens
    name: 'config_versions',
    indexes: [
      { key: { active: 1 },      name: 'ix_active' },
      { key: { created_at: -1 }, name: 'ix_recent' }
    ]
  },

  {
    // Battement de coeur du pipeline. La supervision doit detecter un worker
    // MORT, pas seulement des erreurs : un arret silencieux de plus de ~3 h
    // fait sortir les tokens de la fenetre Pulse, definitivement.
    name: 'system_state',
    indexes: [{ key: { last_beat_at: -1 }, name: 'ix_beat' }]
  },

  {
    // Trades individuels du flux temps réel, pour l'étude : tous ceux des
    // tokens qui dépassent `study_mc`, et ceux d'un échantillon témoin tiré
    // par hachage du mint. Le reste ne vit qu'en mémoire — 1,2 million de
    // trades par jour sur la seule courbe ne tiendraient pas dans la base.
    name: 'trades',
    indexes: [
      { key: { ts: 1 },            name: 'ix_ttl', expireAfterSeconds: 14 * DAY },
      { key: { token: 1, ts: 1 },  name: 'ix_token_ts' },
      { key: { wallet: 1, ts: -1 }, name: 'ix_wallet' }
    ]
  },

  {
    // Pool PumpSwap → mint : les événements de l'AMM ne portent que le pool.
    name: 'pump_pools',
    indexes: [{ key: { mint: 1 }, name: 'ix_mint' }]
  },

  // --- collections analytiques : pré-calculées pour le dashboard ------------
  ...['funnel', 'filter_perf', 'wallets', 'deployers',
      'blindspots', 'discovery', 'regime', 'proposals', 'succes'].map(n => ({
    name: `analytics_${n}`,
    indexes: [{ key: { period: -1 }, name: 'ix_period', unique: true }]
  }))
]

export const collectionNames = collections.map(c => c.name)
