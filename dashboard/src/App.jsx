import { useEffect, useState } from 'react'
import { api } from './api.js'
import { num, usd } from './format.js'
import { Badge } from './components/ui.jsx'
import TokenList from './components/TokenList.jsx'
import TokenDetail from './components/TokenDetail.jsx'

/** Bandeau supérieur : santé du pipeline et volumétrie, d'un coup d'œil. */
function Entete({ o }) {
  const h = o?.health
  const c = o?.funnel?.counts ?? {}

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4
      border-b border-line bg-surface px-4 py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="text-[15px] font-bold tracking-tight text-ink">
          Nexus<span className="text-accent">.</span>
        </span>
        <span className="text-[11px] text-ink-faint">screener multi-chaînes</span>
      </div>

      {o && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${h?.alive ? 'bg-up' : 'bg-down'}`} />
            <span className="text-ink-dim">
              {h?.alive ? 'pipeline actif' : 'pipeline silencieux'}
            </span>
            <span className="text-ink-faint">
              {h?.cycles} cycles · {h?.silenceMinutes} min
            </span>
          </span>

          <span className="text-ink-faint">
            <span className="text-ink-dim">{num(o.counts.tokens)}</span> tokens ·{' '}
            <span className="text-ink-dim">{num(o.counts.snapshots)}</span> décisions ·{' '}
            <span className="text-ink-dim">{num(o.counts.outcomes)}</span> verdicts
          </span>

          <span className="text-ink-faint">
            aujourd'hui : {num(c.vus)} vus → {num(c.admis)} admis → {num(c.franchissements)} franchis
          </span>

          <Badge ton={o.config.alertsEnabled ? 'up' : 'dim'}>
            {o.config.alertsEnabled ? 'alertes actives' : 'calibration'}
          </Badge>
          <span className="text-ink-faint">config v{o.config.version}</span>
        </div>
      )}
    </header>
  )
}

export default function App() {
  const [overview, setOverview] = useState(null)
  const [selection, setSelection] = useState(null)

  useEffect(() => {
    const charger = () => api.overview().then(setOverview).catch(() => {})
    charger()
    // Le pipeline tourne en continu : on rafraîchit le bandeau périodiquement.
    const t = setInterval(charger, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex h-full flex-col bg-bg">
      <Entete o={overview} />

      <div className="flex min-h-0 flex-1">
        <aside className="w-[340px] shrink-0 border-r border-line bg-surface/40">
          <TokenList selection={selection} onSelect={setSelection} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <TokenDetail id={selection} />
        </main>
      </div>
    </div>
  )
}
