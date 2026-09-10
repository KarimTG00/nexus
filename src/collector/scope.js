/**
 * Périmètre de surveillance du collecteur de swaps.
 *
 * Deux endroits doivent s'accorder, sans quoi le système se contredit :
 *   - `addressesToWatch()` déclare les adresses à Helius
 *   - `watchedMints()` filtre ce qu'on accepte à l'arrivée
 *
 * Les laisser diverger ferait soit payer des livraisons qu'on jette, soit
 * rejeter des swaps qu'on a demandés. D'où cette source unique.
 *
 * ⚠️ Ce que le périmètre restreint coûte, mesuré sur la base réelle :
 * 26 676 des 32 752 positions ouvertes sur des tokens promus l'ont été AVANT
 * leur promotion — 81 %. Le délai médian entre découverte et promotion est de
 * 48 minutes, 125 au 90e centile. Un wallet alpha entré pendant cette fenêtre
 * n'aura donc pas d'entrée enregistrée, seulement une sortie : ni gain
 * calculable, ni précocité mesurable. C'est M2 qui est amputé, pas un détail
 * de volumétrie.
 *
 * Le rattrapage d'historique à la promotion est ce qui lève cette limite ;
 * tant qu'il n'est pas écrit, le périmètre large reste le seul moyen de voir
 * les entrées précoces — au prix de ~745 000 livraisons Helius par jour contre
 * ~92 000 ici.
 */

/** Périmètre étroit : uniquement les tokens que le pipeline a retenus. */
export const SURVEILLES_ETROIT = ['tracked', 'triggered', 'alerted']

/** Périmètre large : inclut les candidats en attente, donc les entrées précoces. */
export const SURVEILLES_LARGE = ['pending_activity', 'tracked', 'triggered', 'alerted']

/**
 * Statuts effectivement surveillés, PAR CHAÎNE.
 *
 * Le bon périmètre n'est pas le même partout, parce que le mode de collecte
 * ne l'est pas :
 *
 *   Solana  sondage RPC — un appel par token et par passage. Élargir le
 *           périmètre multiplie le coût. D'où l'étroit par défaut.
 *   EVM     abonnement `eth_subscribe` — un filtre côté serveur, quel que
 *           soit le nombre d'adresses. Élargir ne coûte rien de plus, et
 *           rend les entrées pré-promotion à M2, soit 81 % des entrées.
 *
 * `watch_statuses` accepte donc les deux formes :
 *   ['tracked', …]                       même périmètre partout
 *   { defaut: [...], base: [...], … }    par chaîne, avec repli sur `defaut`
 */
export function statutsSurveilles(cfg, chaine = null) {
  const v = cfg?.thresholds?.collector?.watch_statuses
  if (!v) return chaine && chaine !== 'solana' ? SURVEILLES_LARGE : SURVEILLES_ETROIT
  if (Array.isArray(v)) return v
  return v[chaine] ?? v.defaut ?? SURVEILLES_ETROIT
}
