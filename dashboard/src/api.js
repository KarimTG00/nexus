/**
 * Client API — lecture seule.
 * Le jeton n'est requis que si le service web définit API_TOKEN.
 */
const BASE = import.meta.env.VITE_API_URL ?? ''
const TOKEN = import.meta.env.VITE_API_TOKEN ?? ''

async function get(path, params) {
  const url = new URL(BASE + path, window.location.origin)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  }
  const res = await fetch(url, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`)
  return res.json()
}

export const api = {
  overview: () => get('/api/overview'),
  tokens: params => get('/api/tokens', params),
  token: id => get(`/api/tokens/${encodeURIComponent(id)}`),
  triggers: params => get('/api/triggers', params)
}
