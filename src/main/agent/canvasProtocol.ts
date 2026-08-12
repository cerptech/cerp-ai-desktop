/**
 * canvasProtocol — registra el scheme `cerp-canvas://` y lo sirve desde el
 * proceso main, con la CSP del lienzo puesta como HEADER real de la respuesta.
 *
 * Ver el comentario largo en `htmlCanvasBridge.ts` para el porqué: un
 * `<iframe srcDoc>` con CSP en un `<meta>` tag NO alcanza — se intersecta con
 * la CSP del renderer (`script-src 'self'`, sin `unsafe-inline`) porque
 * `about:srcdoc` cuenta como parte del mismo documento para el spec de CSP.
 * Sirviendo el lienzo desde este scheme, la respuesta lleva su propia CSP por
 * header y no hay intersección posible: es una navegación a otro origen.
 *
 * `registerCanvasProtocolPrivileges()` DEBE correr antes de que la app esté
 * "ready" (requisito de Electron para `protocol.registerSchemesAsPrivileged`)
 * — se llama a nivel de módulo en `src/main/index.ts`, antes del bloque de
 * `app.requestSingleInstanceLock()`. `registerCanvasProtocolHandler()` se
 * llama dentro de `app.whenReady()`, que es cuando `protocol.handle` ya puede
 * usarse.
 */
import { protocol } from 'electron'
import { getCanvasHtml } from './htmlCanvasBridge'
import { logger } from '../utils/logger'

export const CANVAS_PROTOCOL_SCHEME = 'cerp-canvas'

/** Exportada para reutilizar el MISMO string en `canvas:open-external` (handlers.ts)
 *  — el HTML que se escribe a disco para abrir en el navegador del sistema no pasa
 *  por este protocolo (no hay header de respuesta posible en un archivo local), así
 *  que necesita la CSP como `<meta>` tag. Debe ser la misma política, no una copia. */
export const CANVAS_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"

/**
 * Sufijo del documento: mide y reporta su alto vía `postMessage` al padre —
 * único canal de salida que le queda al lienzo (sandbox sin `allow-same-origin`,
 * CSP sin red). Mide el BODY y nunca `documentElement.scrollHeight` (ese
 * devuelve el máximo entre contenido y viewport del iframe, así que con
 * contenido corto informaría el alto que ya tiene el marco y el lienzo jamás
 * encogería).
 */
const HEIGHT_REPORTER = `<script>
(function () {
  var last = 0;
  function report() {
    var body = document.body;
    if (!body) return;
    var h = Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight));
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

/** Envuelve el HTML del agente en un documento con base tipográfica sobria.
 *  La CSP va SOLO por header (ver CANVAS_CSP en el Response) — no hace falta
 *  duplicarla en un meta tag acá, la respuesta ya no depende de eso.
 *  Exportada: `canvas:open-external` (handlers.ts) la reutiliza para no duplicar
 *  el armado del documento, y le inyecta la CSP como `<meta>` tag aparte (ver
 *  comentario de CANVAS_CSP arriba). */
export function buildCanvasDocument(html: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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

/** Debe correr antes de `app.whenReady()`. */
export function registerCanvasProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CANVAS_PROTOCOL_SCHEME,
      privileges: {
        standard: false,
        secure: true,
        corsEnabled: false,
        supportFetchAPI: false,
        bypassCSP: false,
      },
    },
  ])
}

/** `cerp-canvas://<id>` — sin path adicional. Con `standard:false` no hay
 *  garantía de que Chromium parsee host/pathname como una URL normal, así
 *  que se extrae el id a mano en vez de confiar en `new URL(request.url)`. */
function extractCanvasId(requestUrl: string): string | null {
  const match = /^cerp-canvas:\/\/+([^/?#]+)/i.exec(requestUrl)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/** Debe correr dentro de `app.whenReady()`. */
export function registerCanvasProtocolHandler(): void {
  protocol.handle(CANVAS_PROTOCOL_SCHEME, (request) => {
    const id = extractCanvasId(request.url)
    const html = id ? getCanvasHtml(id) : undefined

    if (!html) {
      logger.warn(`cerp-canvas: lienzo no encontrado (id=${id ?? 'sin id'})`)
      return new Response('Lienzo no encontrado o expirado.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    return new Response(buildCanvasDocument(html), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CANVAS_CSP,
      },
    })
  })
}
