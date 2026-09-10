import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { usd, num, dateHeure } from '../format.js'
import { Card, Stat, Badge, Empty, Spinner, ChainDot } from './ui.jsx'
import { CHAINES } from '../format.js'

/**
 * M9 — ce que le système a réellement attrapé.
 *
 * Un token n'a pas réussi parce qu'il est monté, mais parce qu'on l'a attrapé
 * AVANT qu'il monte. D'où deux colonnes partout : ce qui est monté, et ce qui
 * était attrapable. L'écart entre les deux est le diagnostic.
 */
export default function Succes() {
  const [d, setD] = useState(null)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    api.succes().then(setD).catch(e => setErreur(e.message))
  }, [])

  if (erreur) return <Empty>Erreur : {erreur}</Empty>
  if (!d) return <Spinner />
  if (d.vide) {
    return (
      <Empty>
        Analyse jamais exécutée.<br />
        <span className="text-[11px]">Lancer <code>npm run analytics m9</code></span>
      </Empty>
    )
  }

  const p = d.parametres ?? {}
  const paliers = p.paliers ?? []
  const base = d.depart_connu ?? 0

  return (
    <div className="space-y-4 p-4">
      <Card title="Définition retenue">
        <p className="text-[12px] leading-relaxed text-ink-dim">
          Un token <b className="text-ink">réussi</b> a été surveillé, puis alerté alors que sa
          capitalisation était encore sous <b className="text-ink">{usd(p.plafond_capture)}</b>,
          et a ensuite dépassé <b className="text-ink">{usd(p.seuil_reussite)}</b>.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Un token déjà au-dessus du plafond quand on l'a vu n'est pas comptabilisé : le
          mouvement avait eu lieu, il n'y avait rien à attraper. C'est ce qui sépare les deux
          colonnes ci-dessous, et l'écart entre elles est plus instructif que l'un ou l'autre
          chiffre pris seul.
        </p>
      </Card>

      <Card title="Tokens surveillés">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Surveillés" value={num(d.surveilles)} />
          <Stat label="Départ connu" value={num(base)}
            hint="base de calcul des attrapables" />
          <Stat label="Tokens alertés" value={num(d.tokens_alertes)} />
          <Stat label="Réussis" value={num(d.reussis)}
            ton={d.reussis > 0 ? 'up' : 'down'} />
        </div>
      </Card>

      <Card title="Combien finissent par exploser">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 pr-4 font-medium">Palier</th>
                <th className="py-1.5 pr-4 text-right font-medium">Tous</th>
                <th className="py-1.5 pr-4 text-right font-medium">%</th>
                <th className="py-1.5 pr-4 text-right font-medium">Attrapables</th>
                <th className="py-1.5 text-right font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {paliers.map(x => (
                <tr key={x} className="border-b border-line-soft">
                  <td className="py-1.5 pr-4 text-ink">au-dessus de {usd(x)}</td>
                  <td className="py-1.5 pr-4 text-right text-ink-dim">{num(d.explosés?.[x])}</td>
                  <td className="py-1.5 pr-4 text-right text-ink-faint">{d.taux_explosion?.[x]} %</td>
                  <td className="py-1.5 pr-4 text-right font-semibold text-ink">{num(d.montés?.[x])}</td>
                  <td className="py-1.5 text-right text-ink-faint">{d.taux_montee?.[x]} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
          « Tous » inclut les tokens déjà hauts à la découverte — fréquent, la capitalisation de
          la source étant agrégée sur toutes les chaînes : un jeton ancien qui reçoit un nouveau
          pool apparaît d'emblée à plusieurs millions. « Attrapables » ne retient que ceux partis
          sous le plafond de capture, les seuls dont l'absence serait un échec du système.
        </p>
      </Card>

      <Card title="Alertes envoyées"
        right={<span className="text-[11px] text-ink-faint">{d.taux_reussite} % de réussite</span>}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Alertes" value={num(d.alertes_total)}
            hint={`${num(d.tokens_alertes)} tokens distincts`} />
          <Stat label="Réussies" value={num(d.reussis)} ton={d.reussis > 0 ? 'up' : undefined} />
          <Stat label="Trop haut" value={num(d.alertes_trop_haut)}
            ton={d.alertes_trop_haut > 0 ? 'down' : undefined}
            hint="au-dessus du plafond de capture" />
          <Stat label="Sans montée" value={num(d.alertes_sans_montee)}
            hint="attrapées, mais jamais montées" />
        </div>
        {d.alertes_trop_haut > 0 && (
          <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
            Une alerte envoyée trop haut n'est pas un mauvais score : c'est une alerte qui
            n'aurait pas dû partir. Le filtre <code className="text-ink-dim">mc_too_high</code> les
            bloque désormais.
          </p>
        )}
      </Card>

      <Card title={`Tokens réussis — ${d.liste?.length ?? 0}`}>
        {!d.liste?.length ? (
          <Empty>Aucun token ne satisfait la définition pour l'instant.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-1.5 pr-4 font-medium">Token</th>
                  <th className="py-1.5 pr-4 text-right font-medium">MC à l'alerte</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Sommet</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Multiple</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Score</th>
                  <th className="py-1.5 font-medium">Alertée le</th>
                </tr>
              </thead>
              <tbody>
                {d.liste.map(t => (
                  <tr key={t.token} className="border-b border-line-soft">
                    <td className="py-1.5 pr-4">
                      <span className="flex items-center gap-2">
                        <ChainDot chain={t.chain} chaines={CHAINES} />
                        <span className="font-semibold text-ink">{t.symbol || '—'}</span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 text-right text-ink-dim">{usd(t.mc_alerte)}</td>
                    <td className="py-1.5 pr-4 text-right text-ink">{usd(t.mc_sommet)}</td>
                    <td className="py-1.5 pr-4 text-right font-semibold text-up">×{t.multiple}</td>
                    <td className="py-1.5 pr-4 text-right text-ink-faint">{t.score ?? '—'}</td>
                    <td className="py-1.5 text-[11px] text-ink-faint">{dateHeure(t.alerte_le)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-[11px] text-ink-faint">
        Rapport du {d.period}{d.genere_le ? ` — généré ${dateHeure(d.genere_le)}` : ''}
      </p>
    </div>
  )
}
