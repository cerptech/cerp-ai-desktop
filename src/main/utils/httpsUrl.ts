/**
 * `url` si es una URL https válida; `null` en cualquier otro caso.
 *
 * Lo usan los enlaces que el main abre en el navegador (`shell.openExternal`)
 * o que el renderer pinta (logos): solo https, nunca `file:`, `javascript:` ni
 * esquemas propios, aunque el valor venga del core.
 */
export function httpsUrlOrNull(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}
