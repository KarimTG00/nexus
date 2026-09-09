import { MongoClient } from 'mongodb'
import { mod } from '../logger.js'

const log = mod('db')

let client = null
let db = null

export async function connect() {
  if (db) return db

  client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30_000,   // Atlas M0 met du temps à se réveiller
    retryWrites: true,
    maxPoolSize: 20
  })

  await client.connect()
  db = client.db()   // la base vient du chemin de l'URI

  const { version } = await db.admin().serverStatus()
  log.info({ base: db.databaseName, version }, 'MongoDB connecté')
  return db
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
