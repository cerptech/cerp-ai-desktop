/**
 * desktopNotifier — aviso del sistema operativo cuando un trabajo largo termina o
 * falla y el usuario NO está mirando la app (RQM-166: el cliente se queda delante de
 * otra ventana esperando una carga de presupuesto; el desenlace tiene que llegarle).
 *
 * Solo notifica si la ventana no tiene el foco — con la app delante, el banner y el
 * chat ya lo dicen. Click en la notificación → trae la ventana al frente.
 */
import { Notification, type BrowserWindow } from 'electron'
import { logger } from '../utils/logger'

let mainWindowRef: BrowserWindow | null = null

export function setNotifierWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

export function notifyUser(title: string, body: string): void {
  const win = mainWindowRef
  if (!win || win.isDestroyed() || win.isFocused()) return
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch (err) {
    logger.warn(`No se pudo mostrar la notificación del sistema: ${err instanceof Error ? err.message : String(err)}`)
  }
}
