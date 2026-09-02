import { exec } from 'child_process'
import { promisify } from 'util'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createWriteStream, unlinkSync, existsSync } from 'fs'
import https from 'https'
import http from 'http'
import { logger } from './logger'

const execAsync = promisify(exec)

export interface DependencyStatus {
  installed: boolean
  version?: string
}

export interface PythonStatus extends DependencyStatus {
  pipInstalled: boolean
}

const PYTHON_VERSION = '3.12.8'
const PYTHON_URLS: Record<string, string> = {
  win32: `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`,
  darwin: `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-macos11.pkg`,
}

const GIT_VERSION = '2.47.1'
const GIT_URLS: Record<string, string> = {
  win32: `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/Git-${GIT_VERSION}-64-bit.exe`,
  darwin: '', // macOS: xcode-select --install
}

// ============================================================
// Git detection and installation
// ============================================================

export async function checkGit(): Promise<DependencyStatus> {
  try {
    const { stdout } = await execAsync('git --version', { timeout: 10_000 })
    const version = stdout.trim()
    return { installed: true, version }
  } catch {
    return { installed: false }
  }
}

export async function installGit(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  if (process.platform === 'win32') {
    return installGitWindows(onProgress)
  } else if (process.platform === 'darwin') {
    return installGitMac(onProgress)
  } else {
    return installGitLinux(onProgress)
  }
}

async function installGitWindows(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  const url = GIT_URLS.win32
  const installerPath = join(app.getPath('temp'), `Git-${GIT_VERSION}-64-bit.exe`)

  try {
    onProgress('Descargando Git...', 10)
    await downloadFile(url, installerPath, (p) => {
      onProgress(`Descargando Git... ${p}%`, 10 + Math.round(p * 0.5))
    })

    onProgress('Instalando Git (esto puede tardar un minuto)...', 65)
    await execAsync(
      `"${installerPath}" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="icons,ext\\reg\\shellhere,assoc,assoc_sh"`,
      { timeout: 5 * 60 * 1000 },
    )

    onProgress('Verificando instalacion...', 90)
    try { unlinkSync(installerPath) } catch { /* ignore */ }

    const status = await checkGit()
    if (status.installed) {
      onProgress('Git instalado correctamente', 100)
      logger.info(`Git installed: ${status.version}`)
      return true
    }

    // Git installer may need PATH refresh
    onProgress('Git instalado — reinicia la app para completar', 100)
    return true
  } catch (err) {
    logger.error(`Git install failed: ${err}`)
    try { unlinkSync(installerPath) } catch { /* ignore */ }
    return false
  }
}

async function installGitMac(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  try {
    onProgress('Instalando Git via Xcode tools...', 30)
    await execAsync('xcode-select --install', { timeout: 5 * 60 * 1000 })
    const status = await checkGit()
    if (status.installed) {
      onProgress('Git instalado correctamente', 100)
      return true
    }

    // Try Homebrew
    onProgress('Intentando con Homebrew...', 60)
    await execAsync('brew install git', { timeout: 5 * 60 * 1000 })
    const retryStatus = await checkGit()
    if (retryStatus.installed) {
      onProgress('Git instalado correctamente', 100)
      return true
    }
    return false
  } catch (err) {
    logger.error(`Git install failed on Mac: ${err}`)
    return false
  }
}

async function installGitLinux(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  try {
    onProgress('Instalando Git...', 30)
    const managers = [
      'apt-get install -y git',
      'dnf install -y git',
      'yum install -y git',
      'pacman -S --noconfirm git',
    ]
    for (const cmd of managers) {
      try {
        await execAsync(`sudo ${cmd}`, { timeout: 5 * 60 * 1000 })
        const status = await checkGit()
        if (status.installed) {
          onProgress('Git instalado correctamente', 100)
          return true
        }
      } catch { continue }
    }
    return false
  } catch (err) {
    logger.error(`Git install failed on Linux: ${err}`)
    return false
  }
}

// ============================================================
// Python detection and installation
// ============================================================

/**
 * Check if Python 3 is available on the system
 */
export async function checkPython(): Promise<PythonStatus> {
  if (process.platform === 'win32') {
    return checkPythonWindows()
  }

  const commands = ['python3 --version', 'python --version']

  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 10_000 })
      const version = stdout.trim()
      if (version.match(/Python 3\.\d+/)) {
        // Check pip
        const pythonCmd = cmd.replace(' --version', '')
        try {
          await execAsync(`${pythonCmd} -m pip --version`, { timeout: 10_000 })
          return { installed: true, version, pipInstalled: true }
        } catch {
          return { installed: true, version, pipInstalled: false }
        }
      }
    } catch {
      continue
    }
  }

  return { installed: false, pipInstalled: false }
}

/**
 * Windows-only Python detection.
 *
 * When Python isn't actually installed, Windows registers `python.exe` /
 * `python3.exe` (and now `py.exe`, via the Store's "Python Install Manager")
 * as app execution aliases under WindowsApps. Running those stubs doesn't
 * fail — it launches the Microsoft Store instead. So we resolve each
 * candidate with `where` (a pure PATH lookup, doesn't execute the target)
 * and skip anything that resolves into WindowsApps before ever running
 * `--version` on it.
 */
async function checkPythonWindows(): Promise<PythonStatus> {
  const candidates: Array<{ cmd: string; versionArgs: string }> = [
    { cmd: 'python', versionArgs: '--version' },
    { cmd: 'python3', versionArgs: '--version' },
    { cmd: 'py', versionArgs: '-3 --version' },
  ]

  for (const { cmd, versionArgs } of candidates) {
    const resolvedPath = await resolveWindowsCommandPath(cmd)
    if (!resolvedPath || isWindowsStoreAlias(resolvedPath)) {
      continue
    }

    try {
      const { stdout } = await execAsync(`${cmd} ${versionArgs}`, { timeout: 10_000 })
      const version = stdout.trim()
      if (version.match(/Python 3\.\d+/)) {
        const pipCmd = cmd === 'py' ? 'py -3' : cmd
        try {
          await execAsync(`${pipCmd} -m pip --version`, { timeout: 10_000 })
          return { installed: true, version, pipInstalled: true }
        } catch {
          return { installed: true, version, pipInstalled: false }
        }
      }
    } catch {
      continue
    }
  }

  return { installed: false, pipInstalled: false }
}

/**
 * Resolve a command to its target path via `where`, without executing it.
 */
async function resolveWindowsCommandPath(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`where ${cmd}`, { timeout: 5_000 })
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return first ?? null
  } catch {
    return null
  }
}

function isWindowsStoreAlias(resolvedPath: string): boolean {
  return resolvedPath.toLowerCase().includes('\\windowsapps\\')
}

/**
 * Download a file from a URL to a local path with progress
 */
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const file = createWriteStream(dest)

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          file.close()
          downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject)
          return
        }
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10)
      let downloaded = 0

      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        if (totalSize > 0 && onProgress) {
          onProgress(Math.round((downloaded / totalSize) * 100))
        }
      })

      response.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
    })

    request.on('error', (err) => {
      file.close()
      try { unlinkSync(dest) } catch { /* ignore */ }
      reject(err)
    })

    file.on('error', (err) => {
      file.close()
      try { unlinkSync(dest) } catch { /* ignore */ }
      reject(err)
    })
  })
}

/**
 * Auto-install Python for the current platform
 */
export async function installPython(
  mainWindow: BrowserWindow,
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  const platform = process.platform

  if (platform === 'win32') {
    return installPythonWindows(onProgress)
  } else if (platform === 'darwin') {
    return installPythonMac(onProgress)
  } else {
    return installPythonLinux(onProgress)
  }
}

async function installPythonWindows(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  const url = PYTHON_URLS.win32
  const installerPath = join(app.getPath('temp'), `python-${PYTHON_VERSION}-amd64.exe`)

  try {
    onProgress('Descargando Python...', 10)
    await downloadFile(url, installerPath, (p) => {
      onProgress(`Descargando Python... ${p}%`, 10 + Math.round(p * 0.5))
    })

    onProgress('Instalando Python (esto puede tardar un minuto)...', 65)
    // Silent install, per-user, prepend PATH, include pip
    await execAsync(
      `"${installerPath}" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1`,
      { timeout: 5 * 60 * 1000 },
    )

    onProgress('Verificando instalacion...', 90)
    // Clean up installer
    try { unlinkSync(installerPath) } catch { /* ignore */ }

    // Verify
    const status = await checkPython()
    if (status.installed) {
      onProgress('Python instalado correctamente', 100)
      logger.info(`Python installed: ${status.version}`)
      return true
    }

    logger.warn('Python installer ran but python not found in PATH — may need shell restart')
    onProgress('Python instalado — reinicia la app para completar', 100)
    return true
  } catch (err) {
    logger.error(`Python install failed: ${err}`)
    try { unlinkSync(installerPath) } catch { /* ignore */ }
    return false
  }
}

async function installPythonMac(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  const url = PYTHON_URLS.darwin
  const pkgPath = join(app.getPath('temp'), `python-${PYTHON_VERSION}-macos11.pkg`)

  try {
    onProgress('Descargando Python...', 10)
    await downloadFile(url, pkgPath, (p) => {
      onProgress(`Descargando Python... ${p}%`, 10 + Math.round(p * 0.5))
    })

    onProgress('Instalando Python...', 65)
    // Install the pkg — this will prompt for admin password via macOS UI
    await execAsync(`installer -pkg "${pkgPath}" -target CurrentUserHomeDirectory`, {
      timeout: 5 * 60 * 1000,
    })

    onProgress('Verificando instalacion...', 90)
    try { unlinkSync(pkgPath) } catch { /* ignore */ }

    const status = await checkPython()
    if (status.installed) {
      onProgress('Python instalado correctamente', 100)
      logger.info(`Python installed: ${status.version}`)
      return true
    }

    // Fallback: try Homebrew
    onProgress('Intentando con Homebrew...', 70)
    try {
      await execAsync('brew install python3', { timeout: 5 * 60 * 1000 })
      const retryStatus = await checkPython()
      if (retryStatus.installed) {
        onProgress('Python instalado correctamente', 100)
        return true
      }
    } catch { /* Homebrew not available */ }

    return false
  } catch (err) {
    logger.error(`Python install failed on Mac: ${err}`)
    try { unlinkSync(pkgPath) } catch { /* ignore */ }
    return false
  }
}

async function installPythonLinux(
  onProgress: (message: string, percent: number) => void,
): Promise<boolean> {
  try {
    // Try common package managers
    onProgress('Instalando Python...', 30)

    const managers = [
      'apt-get install -y python3 python3-pip',
      'dnf install -y python3 python3-pip',
      'yum install -y python3 python3-pip',
      'pacman -S --noconfirm python python-pip',
    ]

    for (const cmd of managers) {
      try {
        await execAsync(`sudo ${cmd}`, { timeout: 5 * 60 * 1000 })
        const status = await checkPython()
        if (status.installed) {
          onProgress('Python instalado correctamente', 100)
          return true
        }
      } catch {
        continue
      }
    }

    return false
  } catch (err) {
    logger.error(`Python install failed on Linux: ${err}`)
    return false
  }
}
