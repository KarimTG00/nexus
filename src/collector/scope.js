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
 * Statuts effectivement surveillés.
 *
 * Pilotés par la configuration pour qu'un changement d'avis ne demande pas un
 * déploiement de code — `active()` ne fusionnant pas avec les valeurs par
 * défaut, le repli couvre les versions antérieures.
 */
export function statutsSurveilles(cfg) {
  return cfg?.thresholds?.collector?.watch_statuses ?? SURVEILLES_ETROIT
}
