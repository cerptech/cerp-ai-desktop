import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

/**
 * El lienzo HTML del agente (tool `show_html`).
 *
 * # Este componente ES la medida de seguridad
 *
 * Todo lo demás del contrato son datos y la UI decide cómo se ven. Acá el
 * marcado lo escribe un modelo, así que renderizarlo es ejecutar código que no
 * controlamos en el equipo del usuario. Portado 1:1 del modelo de seguridad
 * del canal web (cerp-ai-frontend/src/components/chat/parts/HtmlCanvasCard.tsx)
 * — tres cosas lo hacen aceptable, y ninguna es opcional:
 *
 * 1. **`sandbox="allow-scripts"` SIN `allow-same-origin`.** El documento queda
 *    en un origen opaco: no puede leer cookies, `localStorage`, el token de
 *    sesión (que en Electron vive en el proceso main, ni siquiera en el
 *    renderer) ni el DOM del padre. Poner las dos flags juntas anula el
 *    sandbox entero — con ambas, el documento puede reescribir su propio
 *    atributo `sandbox` y escapar. Nunca las dos.
 *
 *    Nota Electron: `webPreferences.sandbox: false` del BrowserWindow (ver
 *    `src/main/index.ts`) es el sandbox de PROCESO de Electron (aislar el
 *    renderer de Node — está en false porque el Agent SDK necesita spawnear
 *    procesos hijos). Es un mecanismo completamente distinto del atributo
 *    `sandbox` de un `<iframe>` del DOM, que sigue siendo el de Chromium y
 *    no lo afecta: un iframe sandboxeado adentro de un BrowserWindow con
 *    `sandbox: false` sigue aislado igual.
 *
 * 2. **CSP propia dentro del documento, sin red.** `default-src 'none'` corta
 *    `fetch`, `XHR`, WebSocket, imágenes remotas, fuentes y scripts externos.
 *    Aunque el modelo escribiera código para mandar datos de la conversación
 *    afuera, no tiene por dónde — ni siquiera puede llegar al backend de CERP.
 *    Se permiten `data:` para imágenes y estilos/scripts inline, que es lo que
 *    el lienzo necesita.
 *
 * 3. **Ni formularios, ni navegación, ni popups.** No están en el `sandbox`,
 *    así que un `<a target="_top">` o un `<form>` no llevan al usuario a
 *    ninguna parte.
 *
 * Lo que el documento SÍ puede hacer es `postMessage` al padre — es la única
 * vía que le queda hacia afuera. Por eso el listener de abajo verifica
 * `event.source` contra el `contentWindow` de ESTE iframe y valida la forma
 * del mensaje antes de creerle nada.
 *
 * # Altura
 *
 * Con origen opaco el padre no puede medir el contenido (leer el documento del
 * iframe es justo lo que el aislamiento impide). Así que el lienzo la reporta
 * él mismo con un `ResizeObserver` y el padre la acota. Si el mensaje nunca
 * llega, queda la altura por defecto y el contenido hace scroll dentro del
 * marco en vez de cortarse.
 */

const MIN_HEIGHT = 80
const MAX_HEIGHT = 1200
const DEFAULT_HEIGHT = 240

/**
 * Sufijo del documento: mide y reporta su alto. Corre DENTRO del sandbox — es
 * el único canal de salida que tiene el lienzo (postMessage, validado del
 * lado del padre en el useEffect de abajo).
 *
 * Mide el BODY y nunca `documentElement.scrollHeight`: ese último devuelve el
 * máximo entre el contenido y el viewport del iframe, así que con contenido
 * corto informaría el alto que ya tiene el marco y el lienzo jamás encogería.
 */
const HEIGHT_REPORTER = `<script>
(function () {
  var last = 0;
  function report() {
    var body = document.body;
    if (!body) return;
    var h = Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight));
    // 0 = todavía sin layout (script inline, pestaña en segundo plano). Un 0
    // reportado encogería el lienzo al mínimo: mejor callarse y esperar.
    if (h <= 0 || h === last) return;
    last = h;
    parent.postMessage({ __cerpCanvas: 'height', value: h }, '*');
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(report).observe(document.body);
  }
  window.addEventListener('load', report);
  report();
})();
</script>`

/**
 * Envuelve el HTML del agente en un documento con su CSP y una base tipográfica
 * sobria. El agente escribe el contenido; el encierro lo ponemos nosotros.
 */
function buildSrcDoc(html: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #1e1e1e;
    background: transparent;
    padding: 14px;
    overflow-x: auto;
  }
  table { border-collapse: collapse; width: 100%; }
  img, svg { max-width: 100%; }
</style>
</head>
<body>
${html}
${HEIGHT_REPORTER}
</body>
</html>`
}

interface HtmlCanvasCardProps {
  title: string
  html: string
}

export function HtmlCanvasCard({ title, html }: HtmlCanvasCardProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(() => clamp(DEFAULT_HEIGHT))
  const [collapsed, setCollapsed] = useState(false)

  // `srcDoc` se recalcula sólo si cambia el HTML: rearmarlo en cada render
  // recargaría el iframe innecesariamente.
  const srcDoc = useMemo(() => buildSrcDoc(html), [html])

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
      {!collapsed && (
        <iframe
          ref={frameRef}
          srcDoc={srcDoc}
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
