import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { usd, num, pct, signed, age, CHAINES, STATUTS } from '../format.js'
import { Badge, ChainDot, Empty, Spinner } from './ui.jsx'

const TRIS = [
  ['mc', 'Market cap'],
  ['recent', 'Découverte'],
  ['age', 'Création'],
  ['liquidite', 'Liquidité'],
  ['holders', 'Holders']
]

const FILTRES = [
  ['', 'Tous'],
  ['tracked,alerted', 'Surveillés'],
  ['pending_activity', 'En attente'],
  ['archived', 'Archivés']
]

export default function TokenList({ selection, onSelect }) {
  const [data, setData] = useState(null)
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState(null)

  const [tri, setTri] = useState('mc')
  const [statut, setStatut] = useState('')
  const [chaine, setChaine] = useState('')
  const [recherche, setRecherche] = useState('')
  const [page, setPage] = useState(0)

  const parPage = 60

  useEffect(() => {
    let annule = false
    setChargement(true)
    api.tokens({ sort: tri, status: statut, chain: chaine, q: recherche, limit: parPage, offset: page * parPage })
      .then(d => { if (!annule) { setData(d); setErreur(null) } })
      .catch(e => { if (!annule) setErreur(e.message) })
      .finally(() => { if (!annule) setChargement(false) })
    return () => { annule = true }
  }, [tri, statut, chaine, recherche, page])

  useEffect(() => { setPage(0) }, [tri, statut, chaine, recherche])

  return (
    <div className="flex h-full flex-col">
      {/* --- filtres ------------------------------------------------------ */}
      <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
        <input
          value={recherche}
          onChange={e => setRecherche(e.target.value)}
          placeholder="Rechercher un ticker…"
          className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm
            text-ink placeholder:text-ink-faint outline-none focus:border-accent/60"
        />
        <div className="flex flex-wrap gap-1">
          {FILTRES.map(([v, label]) => (
            <button key={v} onClick={() => setStatut(v)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition
                ${statut === v ? 'bg-accent/20 text-accent' : 'text-ink-faint hover:bg-raised hover:text-ink-dim'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setChaine('')}
            className={`rounded-md px-2 py-1 text-[11px] transition
              ${chaine === '' ? 'bg-raised text-ink' : 'text-ink-faint hover:text-ink-dim'}`}>
            Toutes
          </button>
          {Object.entries(CHAINES).slice(0, 4).map(([id, c]) => (
            <button key={id} onClick={() => setChaine(chaine === id ? '' : id)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition
                ${chaine === id ? 'bg-raised text-ink' : 'text-ink-faint hover:text-ink-dim'}`}>
              <span className="size-1.5 rounded-full" style={{ background: c.teinte }} />
              {c.nom}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between pt-0.5">
          <select value={tri} onChange={e => setTri(e.target.value)}
            className="rounded-md border border-line bg-raised px-2 py-1 text-[11px] text-ink-dim outline-none">
            {TRIS.map(([v, l]) => <option key={v} value={v}>Trier : {l}</option>)}
          </select>
          <span className="text-[11px] text-ink-faint">
            {data ? `${num(data.total)} token${data.total > 1 ? 's' : ''}` : ''}
          </span>
        </div>
      </div>

      {/* --- liste -------------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {erreur && <Empty>Erreur : {erreur}</Empty>}
        {chargement && !data && <Spinner />}
        {data && data.tokens.length === 0 && <Empty>Aucun token ne correspond.</Empty>}

        {data?.tokens.map(t => {
          const actif = selection === t.id
          const st = STATUTS[t.status] ?? { label: t.status, ton: 'faint' }
          return (
            <button key={t.id} onClick={() => onSelect(t.id)}
              className={`w-full border-b border-line-soft px-4 py-2.5 text-left transition
                ${actif ? 'bg-accent/10' : 'hover:bg-surface'}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className={`truncate text-[13px] font-semibold ${actif ? 'text-accent' : 'text-ink'}`}>
                    {t.symbol || '—'}
                  </span>
                  {t.alerted && <Badge ton="up">alerté</Badge>}
                  {t.muted && <Badge ton="faint">muet</Badge>}
                </span>
                <span className="shrink-0 text-[13px] font-semibold text-ink">{usd(t.mc)}</span>
              </div>

              <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <ChainDot chain={t.chain} chaines={CHAINES} />
                  <span className="text-ink-faint">{age(t.createdAt)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {t.interest !== null && (
                    <span className={t.interest > 0 ? 'text-up' : t.interest < 0 ? 'text-down' : 'text-ink-faint'}>
                      {signed(t.interest)}/5min
                    </span>
                  )}
                  <Badge ton={st.ton}>{st.label}</Badge>
                </span>
              </div>

              <div className="mt-1 flex gap-3 text-[11px] text-ink-faint">
                <span>liq {usd(t.liquidity)}</span>
                <span>{num(t.holders)} holders</span>
                {t.top10 !== null && <span>top10 {pct(t.top10, 0)}</span>}
              </div>
            </button>
          )
        })}
      </div>

      {/* --- pagination --------------------------------------------------- */}
      {data && data.total > parPage && (
        <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-2">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
            className="rounded px-2 py-1 text-[11px] text-ink-dim disabled:opacity-30 hover:bg-raised">
            ← Précédent
          </button>
          <span className="text-[11px] text-ink-faint">
            {page * parPage + 1}–{Math.min((page + 1) * parPage, data.total)}
          </span>
          <button disabled={(page + 1) * parPage >= data.total} onClick={() => setPage(p => p + 1)}
            className="rounded px-2 py-1 text-[11px] text-ink-dim disabled:opacity-30 hover:bg-raised">
            Suivant →
          </button>
        </div>
      )}
    </div>
  )
}
