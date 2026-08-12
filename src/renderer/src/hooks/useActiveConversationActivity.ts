import { useSyncExternalStore } from 'react'
import { subscribeGlobal, getActiveConversationIds } from '@/stores/agentRuntimeStore'

/**
 * useActiveConversationActivity — Set<conversationId> de las conversaciones que
 * están trabajando AHORA MISMO (streaming o pendientes de respuesta), incluidas
 * las que corren en FONDO (no solo la conversación activa en pantalla).
 *
 * Pensado para un ÚNICO suscriptor en `ConversationPanel` que deriva el Set una
 * sola vez y lo reparte a cada ítem de la lista — si cada ítem se suscribiera al
 * store por su cuenta, cada token de streaming re-renderizaría la lista ENTERA.
 *
 * `getActiveConversationIds()` memoiza el Set: devuelve la MISMA referencia
 * mientras el conjunto de ids activos no cambie, así que `useSyncExternalStore`
 * no dispara un re-render en cada tick de streaming (que notifica el store pero
 * no cambia QUIÉN está activo) — solo cuando una conversación entra o sale de
 * actividad.
 */
export function useActiveConversationActivity(): Set<string> {
  return useSyncExternalStore(subscribeGlobal, getActiveConversationIds)
}
