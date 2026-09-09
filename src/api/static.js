/**
 * Service des fichiers statiques du dashboard compilé.
 *
 * Pourquoi le servir depuis l'API plutôt que par un service séparé :
 *
 *   - même origine, donc AUCUN CORS à configurer ni à déboguer ;
 *   - aucune variable `VITE_API_URL` : le client appelle des chemins relatifs,
 *     ce qui évite le piège des variables Vite figées à la compilation ;
 *   - le jeton d'API reste côté serveur. Toute variable `VITE_*` finit en clair
 *     dans le bundle téléchargé par le navigateur — un « secret » public ne
 *     protège rien.
 *
 * Application monopage : toute route inconnue renvoie index.html, sinon un
 * rechargement sur une URL profonde donnerait un 404.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, sep } from 'node:path'
import { mod } from '../core/logger.js'

const log = mod('static')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

export function createStaticHandler(root) {
  let disponible = null

  /** @returns {boolean} true si la requête a été servie */
  return async function serve(req, res, pathname) {
    if (disponible === null) {
      disponible = await stat(join(root, 'index.html')).then(() => true).catch(() => false)
      if (!disponible) {
        log.warn({ root }, 'dashboard non compilé — lancer `npm run build` dans dashboard/')
      }
    }
    if (!disponible) return false

    // Empêche la remontée d'arborescence (`../../etc/passwd`).
    const demande = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    let fichier = join(root, demande)
    if (!fichier.startsWith(root + sep) && fichier !== root) fichier = root

    let contenu
    let type

    try {
      const infos = await stat(fichier)
      if (infos.isDirectory()) throw new Error('répertoire')
      contenu = await readFile(fichier)
      type = TYPES[extname(fichier).toLowerCase()] ?? 'application/octet-stream'
    } catch {
      // Route inconnue → index.html (application monopage)
      try {
        contenu = await readFile(join(root, 'index.html'))
        type = TYPES['.html']
      } catch { return false }
    }

    // Les fichiers versionnés par empreinte (assets/index-A1b2C3.js) ne
    // changent jamais : cache long. index.html doit rester frais, sinon un
    // redéploiement continue de servir l'ancien bundle.
    const immuable = /\/assets\/.+-[A-Za-z0-9_-]{8,}\./.test(pathname)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': contenu.length,
      'Cache-Control': immuable ? 'public, max-age=31536000, immutable' : 'no-cache'
    })
    res.end(contenu)
    return true
  }
}

/**
 * Authentification HTTP Basic — protège le dashboard ET l'API d'un seul geste.
 *
 * Préférée à un jeton passé au navigateur : le navigateur gère la boîte de
 * dialogue nativement, et rien de secret ne transite dans le bundle JavaScript.
 * Les webhooks en sont exemptés — Helius et Telegram ne peuvent pas s'authentifier
 * ainsi, ils ont leurs propres secrets.
 */
export function checkBasicAuth(req, res) {
  const user = process.env.DASHBOARD_USER
  const pass = process.env.DASHBOARD_PASSWORD
  if (!user || !pass) return true          // non configuré : accès libre

  const entete = req.headers.authorization ?? ''
  if (entete.startsWith('Basic ')) {
    const [u, p] = Buffer.from(entete.slice(6), 'base64').toString().split(':')
    if (u === user && p === pass) return true
  }

  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Nexus", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8'
  })
  res.end('Authentification requise')
  return false
}
