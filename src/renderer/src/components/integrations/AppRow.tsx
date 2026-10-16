import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/useToast'
import type { IntegrationCatalogItem } from '../../../../preload/index'

/** Cada cuánto se pregunta al core si la autorización ya llegó, y hasta cuándo. */
const POLL_EVERY_MS = 3000
const POLL_MAX_MS = 2 * 60_000

type Phase = 'idle' | 'starting' | 'waiting' | 'confirm-disconnect' | 'disconnecting'

interface AppRowProps {
  app: IntegrationCatalogItem
  /** Algo cambió (conectó o desconectó): el panel recarga la lista. */
  onChanged: () => void
}

/** Logo real de la app; si no hay o no carga, la inicial sobre un cuadrado. */
export function AppLogo({ name, logo }: { name: string; logo: string | null }) {
  const [failed, setFailed] = useState(false)
  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt=""
        onError={() => setFailed(true)}
        className="size-9 shrink-0 rounded-lg border border-slate-100 bg-white object-contain p-1"
      />
    )
  }
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-500">
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * Una app del catálogo con su acción. Conectar abre el navegador (el main) y
 * después espera: Electron no recibe el redirect de Composio, así que se le
 * pregunta al core cada pocos segundos (`reconcile`, que verifica contra
 * Composio) hasta que la conexión aparece, el usuario pulsa «Ya autoricé» o se
 * cumplen 2 minutos. Desconectar pide confirmación antes.
 */
export function AppRow({ app, onChanged }: AppRowProps) {
  const { addToast } = useToast()
  const [phase, setPhase] = useState<Phase>('idle')
  const [hint, setHint] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef(0)
  // Un chequeo a la vez: si el core tarda más que el intervalo, no se apilan
  // (dos respuestas «active» darían dos avisos de «quedó conectada»).
  const checkingRef = useRef(false)

  const stopPolling = (): void => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }

  // Al cerrar el panel (o cambiar de empresa, que remonta todo) se deja de preguntar.
  useEffect(() => stopPolling, [])

  const checkNow = async (): Promise<void> => {
    if (checkingRef.current) return
    checkingRef.current = true
    let res: Awaited<ReturnType<typeof window.cerpAPI.reconcileIntegration>>
    try {
      res = await window.cerpAPI.reconcileIntegration(app.toolkit)
    } finally {
      checkingRef.current = false
    }
    if (res.ok && res.status === 'active') {
      stopPolling()
      setPhase('idle')
      setHint(null)
      addToast('success', `${app.displayName} quedó conectada.`)
      onChanged()
      return
    }
    if (!res.ok && res.error === 'auth') {
      stopPolling()
      setPhase('idle')
      return
    }
    if (Date.now() - startedAtRef.current > POLL_MAX_MS) {
      stopPolling()
      setHint('No vimos la autorización todavía. Si ya la diste, pulsa «Ya autoricé»; si no, vuelve a conectar.')
    }
  }

  const connect = async (): Promise<void> => {
    setPhase('starting')
    setHint(null)
    const res = await window.cerpAPI.connectIntegration(app.toolkit)
    if (!res.ok) {
      setPhase('idle')
      if (res.error !== 'auth') addToast('error', `No se pudo iniciar la conexión con ${app.displayName}.`)
      return
    }
    setPhase('waiting')
    startedAtRef.current = Date.now()
    stopPolling()
    pollRef.current = setInterval(() => void checkNow(), POLL_EVERY_MS)
  }

  const cancelWaiting = (): void => {
    stopPolling()
    setPhase('idle')
    setHint(null)
  }

  const disconnect = async (): Promise<void> => {
    setPhase('disconnecting')
    const res = await window.cerpAPI.disconnectIntegration(app.toolkit)
    setPhase('idle')
    if (res.ok) {
      addToast('success', `${app.displayName} se desconectó.`)
      onChanged()
    } else if (res.error !== 'auth') {
      addToast('error', `No se pudo desconectar ${app.displayName}.`)
    }
  }

  return (
    <div className="rounded-xl border border-composer-border bg-white p-3">
      <div className="flex items-center gap-3">
        <AppLogo name={app.displayName} logo={app.logo} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-slate-800">{app.displayName}</span>
            {app.connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                Conectada
              </span>
            )}
          </div>
          {app.description && <p className="line-clamp-2 text-xs text-slate-500">{app.description}</p>}
        </div>

        {phase === 'idle' && !app.connected && (
          <button
            type="button"
            onClick={() => void connect()}
            className="shrink-0 rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-orange/90"
          >
            Conectar
          </button>
        )}
        {phase === 'idle' && app.connected && (
          <button
            type="button"
            onClick={() => setPhase('confirm-disconnect')}
            className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            Desconectar
          </button>
        )}
        {(phase === 'starting' || phase === 'disconnecting') && (
          <Loader2 className="size-4 shrink-0 animate-spin text-slate-400" aria-label="Procesando" />
        )}
      </div>

      {phase === 'waiting' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          {!hint && <Loader2 className="size-3.5 animate-spin text-brand-orange" aria-hidden="true" />}
          <p className="min-w-0 flex-1 text-xs text-slate-600">
            {hint ?? `Esperando la autorización de ${app.displayName} en el navegador…`}
          </p>
          <button
            type="button"
            onClick={() => void checkNow()}
            className="rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
          >
            Ya autoricé
          </button>
          <button type="button" onClick={cancelWaiting} className="px-1 text-xs text-slate-400 hover:text-slate-600">
            Cancelar
          </button>
        </div>
      )}

      {phase === 'confirm-disconnect' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-slate-700">
            ¿Desconectar {app.displayName}? CERP AI dejará de poder leerla o usarla.
          </p>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded-lg bg-error px-2.5 py-1 text-xs font-semibold text-white hover:bg-error/90"
          >
            Desconectar
          </button>
          <button type="button" onClick={() => setPhase('idle')} className="px-1 text-xs text-slate-500 hover:text-slate-700">
            Cancelar
          </button>
        </div>
      )}
    </div>
  )
}
