/**
 * toolsSetupStore — chequeo/instalación de Git + Python en BACKGROUND (Ola 3).
 *
 * Antes (SetupPage) esto bloqueaba TODA la app con una pantalla completa antes del
 * login: el usuario tenía que esperar la descarga de Git/Python (~1 min) para ver
 * siquiera el botón de "Iniciar sesión". Ahora el login va primero; este store
 * arranca en background una vez autenticado y las únicas funciones que realmente
 * necesitan estas herramientas (hoy: "Crear cotización de obra", que dispara al
 * report-generator y termina ejecutando cerp_budget_pdf.py) se gatean sobre su
 * estado — el resto del chat funciona igual, tenga o no Git/Python instalados.
 *
 * Git además lo necesita el propio SDK en Windows para el tool Bash (git-bash) —
 * ver CLAUDE_CODE_GIT_BASH_PATH en agentManager.ts — pero eso solo afecta a
 * ejecuciones que usan Bash, no a la conversación en sí.
 *
 * Mismo flujo que tenía SetupPage.runSetup, solo que escribe a este store externo
 * (patrón agentRuntimeStore) en vez de estado de componente, para que cualquier
 * parte de la UI pueda leerlo sin tener que montar una pantalla dedicada.
 */

export type ToolsSetupStatus = 'idle' | 'checking' | 'installing' | 'ready' | 'error'

export interface ToolsSetupState {
  status: ToolsSetupStatus
  step: 'git' | 'python' | 'done'
  message: string
  percent: number
  error: string | null
}

const SETUP_VERSION_KEY = 'cerp-setup-version'
// v2 = incluye el check de Git (histórico de SetupPage). Se mantiene el mismo valor
// para no forzar una reinstalación de usuarios que ya lo tienen resuelto.
const SETUP_VERSION = '2'

let state: ToolsSetupState = {
  status: 'idle',
  step: 'git',
  message: '',
  percent: 0,
  error: null,
}

const listeners = new Set<() => void>()

function setState(patch: Partial<ToolsSetupState>): void {
  state = { ...state, ...patch }
  for (const cb of listeners) cb()
}

export function subscribeToolsSetup(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getToolsSetupSnapshot(): ToolsSetupState {
  return state
}

let started = false
// Guard de re-entrada: sin esto, clicks repetidos en "Reintentar" (o una segunda
// llamada a ensureToolsSetupStarted que se cuele mientras un intento anterior sigue
// corriendo) lanzaban instaladores paralelos de Git/Python — mismo binario, misma
// ruta destino, dos procesos pisándose.
let running = false

/** Idempotente — solo la primera llamada dispara el flujo. */
export function ensureToolsSetupStarted(): void {
  if (started) return
  started = true
  void runSetup()
}

/** Reintento manual (botón "Reintentar" en la función bloqueada). Ignora clicks
 *  mientras ya hay un intento en curso. */
export function retryToolsSetup(): void {
  if (running) return
  void runSetup()
}

async function runSetup(): Promise<void> {
  if (running) return
  running = true
  try {
    await runSetupInner()
  } finally {
    running = false
  }
}

async function runSetupInner(): Promise<void> {
  if (localStorage.getItem(SETUP_VERSION_KEY) === SETUP_VERSION) {
    setState({ status: 'ready', step: 'done', message: 'Entorno listo', percent: 100, error: null })
    return
  }

  setState({ status: 'checking', step: 'git', message: 'Verificando Git...', percent: 5, error: null })

  try {
    const gitStatus = await window.cerpAPI.checkGit()

    if (!gitStatus.installed) {
      setState({ status: 'installing', message: 'Instalando Git (necesario para que el agente ejecute comandos)...', percent: 10 })
      const unsubGit = window.cerpAPI.onGitProgress((data) => {
        setState({ message: data.message, percent: 10 + data.percent * 0.45 })
      })
      const gitSuccess = await window.cerpAPI.installGit()
      unsubGit()

      if (!gitSuccess) {
        setState({
          status: 'error',
          error: 'No se pudo instalar Git automáticamente. Instálalo desde git-scm.com y reintenta.',
        })
        return
      }
    }

    setState({ status: 'checking', step: 'python', message: 'Verificando Python...', percent: 50 })
    const pythonStatus = await window.cerpAPI.checkPython()

    if (!pythonStatus.installed || !pythonStatus.pipInstalled) {
      setState({ status: 'installing', message: 'Instalando Python (necesario para generar PDFs de cotización)...', percent: 55 })
      const unsubPython = window.cerpAPI.onPythonProgress((data) => {
        setState({ message: data.message, percent: 50 + data.percent * 0.45 })
      })
      const pythonSuccess = await window.cerpAPI.installPython()
      unsubPython()

      if (!pythonSuccess) {
        setState({
          status: 'error',
          error: 'No se pudo instalar Python automáticamente. Instálalo desde python.org (3.12+) y reintenta.',
        })
        return
      }
    }

    localStorage.setItem(SETUP_VERSION_KEY, SETUP_VERSION)
    setState({ status: 'ready', step: 'done', message: 'Entorno listo', percent: 100, error: null })
  } catch (err) {
    setState({
      status: 'error',
      error: err instanceof Error ? err.message : 'No se pudo preparar el entorno de herramientas',
    })
  }
}
