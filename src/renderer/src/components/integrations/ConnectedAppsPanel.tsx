import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { AppRow } from './AppRow'
import type { IntegrationCatalogItem, IntegrationsErrorCode } from '../../../../preload/index'

const SEARCH_DEBOUNCE_MS = 350

/**
 * Pantalla «Apps conectadas»: buscar en el catálogo de Composio (~1000 apps,
 * paginado), conectar y desconectar. El estado «Conectada» sale EN VIVO de
 * Composio (el catálogo del core), no de la tabla local, que no se actualiza
 * sola (skill composio, regla 2).
 *
 * Tres estados que no se confunden (igual que IntegrationsScreen de ai.cerp.es):
 * sin resultados ≠ error de red ≠ sesión vencida. Un fallo mostrado como
 * «no hay resultados» hace que el usuario busque otra palabra en vez de reintentar.
 *
 * Las conexiones son por usuario y por empresa: al cambiar de empresa la app
 * remonta ChatPage y este panel se recarga con las de la empresa nueva.
 */
export function ConnectedAppsPanel({ onClose }: { onClose: () => void }) {
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<IntegrationCatalogItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<IntegrationsErrorCode | null>(null)
  // Descarta respuestas viejas: si el usuario sigue tipeando, gana la última búsqueda.
  const requestRef = useRef(0)

  useEffect(() => {
    const id = setTimeout(() => setQuery(rawQuery.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [rawQuery])

  const load = useCallback(async (q: string) => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    const res = await window.cerpAPI.getIntegrationsCatalog(q || undefined)
    if (request !== requestRef.current) return
    setItems(res.items)
    setNextCursor(res.nextCursor)
    setError(res.error ?? null)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load(query)
  }, [query, load])

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMore) return
    const request = requestRef.current
    setLoadingMore(true)
    const res = await window.cerpAPI.getIntegrationsCatalog(query || undefined, nextCursor)
    setLoadingMore(false)
    if (request !== requestRef.current) return
    if (res.error) {
      setError(res.error)
      return
    }
    setItems((prev) => {
      const seen = new Set(prev.map((a) => a.toolkit))
      return [...prev, ...res.items.filter((a) => !seen.has(a.toolkit))]
    })
    setNextCursor(res.nextCursor)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Conectadas primero: es lo que el usuario viene a revisar.
  const sorted = [...items].sort((a, b) => Number(b.connected) - Number(a.connected))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Apps conectadas"
        className="mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Apps conectadas</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Conecta tus apps para que CERP AI pueda leerlas y, siempre con tu confirmación, enviar o crear cosas en ellas.
              Las conexiones son tuyas y de esta empresa.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Buscar una app (Gmail, Calendar, Drive, Notion…)"
              aria-label="Buscar una app"
              autoFocus
              className="w-full rounded-full border border-composer-border bg-white py-2 pl-9 pr-4 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-brand-orange/40"
            />
          </div>
        </div>

        <div className="cerp-scroll flex-1 overflow-y-auto px-6 py-4">
          {loading && items.length === 0 ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-slate-400" aria-label="Cargando" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-slate-700">
                {error === 'auth'
                  ? 'Tu sesión venció. Vuelve a iniciar sesión para ver tus apps.'
                  : 'No se pudieron cargar las apps. Revisa tu conexión e inténtalo de nuevo.'}
              </p>
              {error !== 'auth' && (
                <button
                  type="button"
                  onClick={() => void load(query)}
                  className="rounded-full border border-composer-border px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Reintentar
                </button>
              )}
            </div>
          ) : sorted.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">
              {query ? `No encontramos apps para «${query}».` : 'No hay apps disponibles.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {sorted.map((app) => (
                <AppRow key={app.toolkit} app={app} onChanged={() => void load(query)} />
              ))}
              {nextCursor && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="mx-auto mt-2 inline-flex items-center gap-2 rounded-full border border-composer-border px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  {loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                  Ver más apps
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
