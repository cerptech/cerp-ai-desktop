import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

/**
 * El lienzo HTML del agente (tool `show_html`).
 *
 * # Este componente ES la medida de seguridad
 *
 * Todo lo demás del contrato son datos y la UI decide cómo se ven. Acá el
 * marcado lo escribe un modelo, así que renderizarlo es ejecutar código que no
 * controlamos en el equipo del usuario. Arrancó portado 1:1 del canal web
 * (cerp-ai-frontend/src/components/chat/parts/HtmlCanvasCard.tsx), que usa
 * `<iframe srcDoc>` con la CSP en un `<meta>` tag — pero **eso no sirve acá**:
 * verificado en runtime que un documento `srcDoc` navega como `about:srcdoc`,
 * y el spec de CSP lo trata como parte del MISMO documento que lo embebe. La
 * política efectiva es la INTERSECCIÓN entre la del renderer
 * (`src/renderer/index.html`, `script-src 'self'` sin `unsafe-inline`, porque
 * protege todo lo demás de la app) y la del meta tag del lienzo — esa
 * intersección mata `script-src 'unsafe-inline'` y NINGÚN script inline corre:
 * ni las gráficas del agente ni el reportero de altura, y el iframe queda
 * clavado en 240px.
 *
 * Por eso el iframe de acá NO usa `srcDoc`: apunta a `cerp-canvas://<id>`, un
 * scheme propio que sirve el proceso main (`canvasProtocol.ts`) con la CSP
 * puesta como HEADER real de la respuesta — eso ya no se intersecta con nada,
 * es una navegación a otro origen. El HTML se registra vía IPC
 * (`registerCanvasHtml`) al montar el componente: el Map que lo guarda vive
 * solo en memoria del proceso main (se reinicia con la app), así que un id de
 * una sesión anterior nunca es válido y siempre se re-registra, tanto para un
 * lienzo recién emitido como para uno de una conversación restaurada de la DB.
 *
 * El resto del modelo de seguridad es el mismo que el web, y sigue siendo
 * igual de necesario:
 *
 * 1. **`sandbox="allow-scripts"` SIN `allow-same-origin`.** El documento queda
 *    en un origen opaco: no puede leer cookies, `localStorage` ni el DOM del
 *    padre. Poner las dos flags juntas anula el sandbox entero. Nunca las dos.
 *
 *    Nota Electron: `webPreferences.sandbox: false` del BrowserWindow (ver
 *    `src/main/index.ts`) es el sandbox de PROCESO de Electron (el Agent SDK
 *    necesita spawnear procesos hijos) — mecanismo distinto del atributo
 *    `sandbox` del `<iframe>`, que sigue siendo el de Chromium y no lo afecta.
 *
 * 2. **CSP sin red** (ahora por header, ver arriba): `default-src 'none'`
 *    corta `fetch`, `XHR`, WebSocket, imágenes remotas, fuentes y scripts
 *    externos. Se permiten `data:` para imágenes y estilos/scripts inline.
 *
 * 3. **Ni formularios, ni navegación, ni popups.** No están en el `sandbox`.
 *
 * Lo que el documento SÍ puede hacer es `postMessage` al padre — la única vía
 * que le queda hacia afuera. El listener de abajo verifica `event.source`
 * contra el `contentWindow` de ESTE iframe y valida la forma del mensaje.
 *
 * # Altura
 *
 * Con origen opaco el padre no puede medir el contenido. El lienzo la reporta
 * él mismo con un `ResizeObserver` (dentro del documento que sirve
 * `canvasProtocol.ts`) y el padre la acota acá. Si el mensaje nunca llega,
 * queda la altura por defecto y el contenido hace scroll dentro del marco.
 */

const MIN_HEIGHT = 80
const MAX_HEIGHT = 1200
const DEFAULT_HEIGHT = 240

interface HtmlCanvasCardProps {
  title: string
  html: string
}

type RegisterState = 'loading' | 'ready' | 'failed'

export function HtmlCanvasCard({ title, html }: HtmlCanvasCardProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(() => clamp(DEFAULT_HEIGHT))
  const [collapsed, setCollapsed] = useState(false)
  const [canvasId, setCanvasId] = useState<string | null>(null)
  const [registerState, setRegisterState] = useState<RegisterState>('loading')

  // Registra el HTML en el Map del main SIEMPRE que cambia (o al montar) —
  // nunca asumimos que un id previo sigue siendo válido (ver el comentario
  // largo de arriba). No depende de si el lienzo es "nuevo" o "restaurado":
  // el mismo camino sirve para los dos casos.
  useEffect(() => {
    let cancelled = false
    setRegisterState('loading')
    setCanvasId(null)
    window.cerpAPI
      .registerCanvasHtml(html)
      .then((id) => {
        if (cancelled) return
        if (!id) {
          setRegisterState('failed')
          return
        }
        setCanvasId(id)
        setRegisterState('ready')
      })
      .catch(() => {
        if (!cancelled) setRegisterState('failed')
      })
    return () => {
      cancelled = true
    }
  }, [html])

  const src = useMemo(() => (canvasId ? `cerp-canvas://${canvasId}` : undefined), [canvasId])

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      // El origen es opaco ("null"), así que no sirve para identificar: lo que
      // ata el mensaje a ESTE lienzo es la ventana que lo emitió.
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as unknown
      if (
        typeof data !== 'object' ||
        data === null ||
        (data as { __cerpCanvas?: unknown }).__cerpCanvas !== 'height'
      ) {
        return
      }
      const value = (data as { value?: unknown }).value
      // `> 0` y no sólo `isFinite`: un 0 (documento sin layout todavía) pasaría
      // el clamp como MIN_HEIGHT y encogería un lienzo que estaba bien.
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return
      setHeight(clamp(value))
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <figure className="mt-2 overflow-hidden rounded-2xl border border-composer-border bg-white">
      <figcaption className="flex items-center justify-between gap-2 border-b border-composer-border px-3 py-2">
        <span className="truncate text-xs font-semibold text-[#3f434a]">{title}</span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expandir lienzo' : 'Colapsar lienzo'}
          className="shrink-0 rounded p-1 text-slate-400 outline-none transition-colors hover:bg-black/5 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-brand-orange/40"
        >
          {collapsed ? (
            <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronUp className="size-3.5" strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </figcaption>
      {!collapsed && registerState === 'failed' && (
        <p className="px-3 py-2.5 text-xs text-slate-400">No se pudo mostrar el lienzo.</p>
      )}
      {!collapsed && registerState === 'loading' && (
        <p className="px-3 py-2.5 text-xs text-slate-400">Cargando lienzo…</p>
      )}
      {!collapsed && registerState === 'ready' && src && (
        <iframe
          ref={frameRef}
          src={src}
          title={title}
          // Sin `allow-same-origin`: ver el bloque de arriba. No es un descuido.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="block w-full border-0"
          style={{ height }}
        />
      )}
    </figure>
  )
}

function clamp(value: number): number {
  return Math.min(Math.max(Math.round(value), MIN_HEIGHT), MAX_HEIGHT)
}
