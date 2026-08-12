import { Square } from 'lucide-react'

/**
 * DictationRecordingBar — feedback en vivo de que el micrófono está captando audio.
 *
 * Antes, grabar no daba NINGÚN indicio de que el micrófono andaba: la transcripción
 * recién aparecía al cortar (QA real del usuario: "no se entera de que está tomando
 * bien la información"). Reemplaza al textarea DENTRO del composer mientras
 * `dictationStatus === 'recording'` (ver Composer.tsx) con: punto rojo pulsante,
 * "Escuchando…", un ecualizador que reacciona al volumen real (useDictation.level,
 * 0-1, ya throttled a ~150ms — ver el comentario de ese hook), el timer mm:ss y el
 * botón cuadrado de parar.
 */

interface DictationRecordingBarProps {
  /** Nivel de micrófono 0-1, ya suavizado y throttled por useDictation. */
  level: number
  elapsedSeconds: number
  /** true si no se detecta audio hace más de 3s — hint ámbar de "revisa el micrófono". */
  silence: boolean
  onStop: () => void
}

// Fase relativa por barra para que no todas suban a la vez con el mismo nivel — se ve
// más "ecualizador reaccionando" que "bloque parpadeando".
const BAR_PHASES = [0.55, 0.8, 1, 0.9, 1, 0.7, 1, 0.85, 0.6]

/** Altura mínima visible (%) aun en silencio total, para que la barra nunca desaparezca. */
const MIN_BAR_HEIGHT_PCT = 10

function formatTimer(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds)
  const m = Math.floor(clamped / 60)
  const s = clamped % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function DictationRecordingBar({ level, elapsedSeconds, silence, onStop }: DictationRecordingBarProps) {
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-center gap-3">
        {/* Punto rojo pulsante */}
        <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
        </span>

        <span className="shrink-0 text-[15px] font-medium text-brand-black">Escuchando…</span>

        {/* Ecualizador — cada barra reacciona al nivel real del micrófono con su propia fase */}
        <div className="flex h-5 flex-1 items-end justify-center gap-[3px]" aria-hidden="true">
          {BAR_PHASES.map((phase, i) => {
            const heightPct = Math.max(MIN_BAR_HEIGHT_PCT, Math.min(100, level * phase * 100))
            return (
              <span
                key={i}
                className="w-[3px] rounded-full bg-brand-orange transition-[height] duration-100 ease-out"
                style={{ height: `${heightPct}%` }}
              />
            )
          })}
        </div>

        <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">{formatTimer(elapsedSeconds)}</span>

        <button
          type="button"
          onClick={onStop}
          title="Detener grabación"
          aria-label="Detener grabación"
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-brand-black text-white outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-orange/40 hover:bg-brand-black/85"
        >
          <Square className="size-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
        </button>
      </div>

      {silence && (
        <p className="pl-[22px] text-xs text-amber-600">No se detecta audio — revisa el micrófono.</p>
      )}
    </div>
  )
}
