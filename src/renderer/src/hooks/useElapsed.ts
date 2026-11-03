import { useState, useEffect } from 'react'

/** Duración legible de un paso: «<1s», «4.2s», «3m 12s». */
export function formatDuration(ms: number): string {
  const secs = ms / 1000
  if (secs < 1) return '<1s'
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = Math.floor(secs % 60)
  return `${mins}m ${remainSecs}s`
}

/** Milisegundos desde `startTime`; el intervalo corre SOLO con `running` (un paso cerrado no cuenta). */
export function useElapsed(startTime: number, running: boolean): number {
  const [elapsed, setElapsed] = useState(() => Date.now() - startTime)
  useEffect(() => {
    if (!running) return
    setElapsed(Date.now() - startTime)
    const id = setInterval(() => setElapsed(Date.now() - startTime), 1000)
    return () => clearInterval(id)
  }, [startTime, running])
  return elapsed
}
