/**
 * Client API — lecture seule.
 *
 * Chemins RELATIFS par défaut : le service web sert le dashboard depuis la
 * même origine, donc aucune URL d'API à configurer et aucun CORS à déboguer.
 *
 * ⚠️ Ne jamais mettre de secret dans une variable `VITE_*` : Vite les fige à la
 * COMPILATION et les inscrit en clair dans le bundle téléchargé par le
 * navigateur. L'accès se protège côté serveur, via DASHBOARD_USER et
 * DASHBOARD_PASSWORD — l'authentification Basic est alors portée par le
 * navigateur, sans rien à ajouter ici.
 *
 * `VITE_API_URL` ne sert qu'à viser une API distante depuis un poste de
 * développement. En production, la laisser vide.
 */
const BASE = import.meta.env.VITE_API_URL ?? ''

async function get(path, params) {
  const url = new URL(BASE + path, window.location.origin)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  }

  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`)
  return res.json()
}

export const api = {
  overview: () => get('/api/overview'),
  tokens: params => get('/api/tokens', params),
  token: id => get(`/api/tokens/${encodeURIComponent(id)}`),
  triggers: params => get('/api/triggers', params),
  analytics: () => get('/api/analytics'),
  succes: () => get('/api/succes')
}
