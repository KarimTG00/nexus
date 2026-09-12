import { MongoClient } from 'mongodb'
import { mod } from '../logger.js'

const log = mod('db')

let client = null
let db = null

const attente = ms => new Promise(r => setTimeout(r, ms))

/**
 * Connexion avec réessais.
 *
 * Sans eux, un incident passager côté base tuait les deux workers : `main()`
 * capture, journalise et fait `exit(1)`, l'orchestrateur relance, l'incident
 * dure encore, et la boucle s'installe. Observé en production comme en local —
 * TCP ouvert vers Atlas, TLS jamais abouti, donc les deux services morts au
 * démarrage sans qu'aucune ligne ne dise pourquoi.
 *
 * On ne masque pas une panne durable : après `retries` tentatives on relance
 * l'erreur, et le processus s'arrête comme avant. Ce qu'on absorbe, c'est le
 * creux de quelques dizaines de secondes — bascule de nœud, réveil d'un M0,
 * réinitialisation réseau — qui ne mérite pas de perdre la fenêtre Pulse.
 */
export async function connect({ retries = 5, baseDelayMs = 2000 } = {}) {
  if (db) return db

  // Sans nom de base dans le chemin de l'URI, le pilote se rabat SILENCIEUSEMENT
  // sur une base nommée `test`, qui est vide. Le worker démarrait alors, ne
  // trouvait aucune configuration active, et plantait en boucle trois messages
  // plus loin — sans que rien ne désigne la cause. Observé en production après
  // la migration vers Railway, qui fournit son URI sans chemin.
  const base = (process.env.MONGODB_URI ?? '').split('?')[0].split('/').slice(3).join('/')
  if (!base) {
    throw new Error('MONGODB_URI ne précise aucune base de données — le pilote se rabattrait '
      + 'sur `test`, qui est vide. Ajouter le nom à la fin de l\'URI, '
      + 'par exemple mongodb://…@hôte:27017/memecoins?authSource=admin')
  }

  let derniere = null

  for (let essai = 1; essai <= retries; essai++) {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30_000,   // Atlas M0 met du temps à se réveiller
      retryWrites: true,
      maxPoolSize: 20
    })

    try {
      await client.connect()
      db = client.db()   // la base vient du chemin de l'URI
      const { version } = await db.admin().serverStatus()
      if (essai > 1) log.info({ essai }, 'MongoDB rétabli')
      log.info({ base: db.databaseName, version }, 'MongoDB connecté')
      return db
    } catch (e) {
      derniere = e
      await client.close().catch(() => {})
      client = null

      if (essai === retries) break
      const delai = Math.min(baseDelayMs * 2 ** (essai - 1), 30_000)
      log.warn({ essai, sur: retries, delai, err: e.message },
        'MongoDB injoignable — nouvelle tentative')
      await attente(delai)
    }
  }

  // Diagnostic explicite : ces symptômes se confondent, et sans cette ligne on
  // relit le mauvais indice pendant une heure.
  log.error({ err: derniere?.message },
    'MongoDB injoignable après plusieurs tentatives. Causes usuelles, dans '
    + 'l\'ordre : liste d\'accès réseau Atlas ne contenant plus l\'IP appelante '
    + '(le port TCP répond, mais TLS n\'aboutit jamais), identifiants révoqués, '
    + 'cluster suspendu ou quota de stockage atteint.')
  throw derniere
}

export function getDb() {
  if (!db) throw new Error('MongoDB non connecté — appeler connect() d\'abord')
  return db
}

/** Raccourci : col('tokens') */
export const col = name => getDb().collection(name)

export async function close() {
  if (client) { await client.close(); client = null; db = null }
}
