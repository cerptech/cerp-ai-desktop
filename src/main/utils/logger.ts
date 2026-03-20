import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, mkdirSync } from 'fs'

const LOG_DIR = join(app.getPath('userData'), 'logs')

try {
  mkdirSync(LOG_DIR, { recursive: true })
} catch {
  // ignore
}

function timestamp(): string {
  return new Date().toISOString()
}

function writeLog(level: string, ...args: unknown[]): void {
  const msg = `[${timestamp()}] [${level}] ${args.map(String).join(' ')}`
  console.log(msg)
  try {
    const logFile = join(LOG_DIR, `cerp-ai-${new Date().toISOString().slice(0, 10)}.log`)
    appendFileSync(logFile, msg + '\n')
  } catch {
    // ignore file write errors
  }
}

export const logger = {
  info: (...args: unknown[]) => writeLog('INFO', ...args),
  warn: (...args: unknown[]) => writeLog('WARN', ...args),
  error: (...args: unknown[]) => writeLog('ERROR', ...args),
  debug: (...args: unknown[]) => writeLog('DEBUG', ...args),
}
