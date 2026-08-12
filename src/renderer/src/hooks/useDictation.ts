import { useEffect, useRef, useState } from 'react'

/**
 * useDictation — dictado por voz del composer (Ola 1) + indicador de escucha (Ola —
 * indicador de escucha en el dictado).
 *
 * Graba con MediaRecorder, manda los bytes crudos al main vía IPC (el renderer no
 * tiene el Bearer del backend) y entrega el texto transcripto por callback. El texto
 * NUNCA se envía solo — el caller lo concatena al textarea para que el usuario lo
 * revise antes de mandar: una transcripción con un número mal entendido, enviada
 * sola, es peor que no tener la función.
 *
 * Portado del mismo patrón de cerp-ai-frontend (src/hooks/useDictation.ts) — ahí el
 * audio va por fetch a /api/transcribe; acá va por IPC porque el renderer de Electron
 * no guarda el token de sesión (vive en el main, protegido de la superficie web).
 *
 * ── Nivel de micrófono en vivo ───────────────────────────────────────────────
 * Antes, grabar no daba NINGÚN feedback de que el micrófono estaba captando algo
 * (QA real: "no se entera de que está tomando bien la información") — la
 * transcripción recién aparecía al cortar. Ahora, mientras graba, un
 * `AnalyserNode` sobre el mismo `MediaStream` de `getUserMedia` mide el volumen
 * en cada frame vía `requestAnimationFrame` y lo deja en un ref (`levelRef`) SIN
 * disparar un render de React por frame — a 60fps eso sería carísimo para una
 * barra. Un `setInterval` aparte (150ms, ~6-7fps) es el único que llama a
 * `setLevel`, así que React solo re-renderiza a ese ritmo, suficiente para que
 * una barra tipo ecualizador se vea viva sin recalcular el árbol 60 veces por
 * segundo.
 */

export type DictationStatus = 'idle' | 'recording' | 'transcribing'

export type DictationError = 'permission' | 'unsupported' | 'session' | 'failed'

interface UseDictationOptions {
  /** Texto transcripto, ya recortado. No se llama si vino vacío (silencio/ruido). */
  onTranscript: (text: string) => void
  onError: (kind: DictationError) => void
}

/** Mismo tope que el backend (`/api/desktop/transcribe`, multer 25 MB). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Cada cuánto se publica el nivel suavizado al estado de React (ms). */
const LEVEL_PUBLISH_INTERVAL_MS = 150

/** Nivel por debajo del cual se considera "silencio" para el hint de "no se detecta audio". */
const SILENCE_LEVEL_THRESHOLD = 0.02

/** Cuánto silencio sostenido antes de mostrar el hint ambar. */
const SILENCE_HINT_MS = 3000

export function useDictation({ onTranscript, onError }: UseDictationOptions) {
  const [status, setStatus] = useState<DictationStatus>('idle')
  // Nivel de micrófono 0-1, publicado cada LEVEL_PUBLISH_INTERVAL_MS (throttled — ver
  // comentario de arriba). Segundos transcurridos de la grabación en curso.
  const [level, setLevel] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  // true cuando el nivel se mantuvo ~0 por más de SILENCE_HINT_MS seguidos.
  const [silence, setSilence] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  // ── Medición de nivel: AudioContext + AnalyserNode + rAF ────────────────────
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const levelRef = useRef(0)
  const publishIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const silenceStartRef = useRef<number | null>(null)
  const recordStartRef = useRef(0)

  // Callbacks por ref para que start/stop sean estables sin exigirle al caller
  // memoizar los suyos. Se actualiza en un effect (no durante el render).
  const callbacksRef = useRef({ onTranscript, onError })
  useEffect(() => {
    callbacksRef.current = { onTranscript, onError }
  })

  /** Arranca el AudioContext + AnalyserNode sobre el stream y el loop de rAF que mide
   *  el volumen. Best-effort: si el AudioContext falla (política de autoplay, browser
   *  raro), la grabación sigue igual — el nivel es un adorno visual, no crítico. */
  const startLevelMonitor = (stream: MediaStream): void => {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextCtor) return

      const audioContext = new AudioContextCtor()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)
      audioContextRef.current = audioContext
      analyserRef.current = analyser

      const data = new Uint8Array(analyser.frequencyBinCount)
      const loop = (): void => {
        analyser.getByteTimeDomainData(data)
        // RMS de la waveform normalizada a -1..1 (128 = silencio absoluto en unsigned 8-bit).
        let sumSquares = 0
        for (let i = 0; i < data.length; i++) {
          const normalized = (data[i] - 128) / 128
          sumSquares += normalized * normalized
        }
        const rms = Math.sqrt(sumSquares / data.length)
        // Ganancia x4 para que un volumen de voz normal llene la barra, clamp a 1.
        const boosted = Math.min(1, rms * 4)
        // Suavizado exponencial: evita que la barra "tiemble" frame a frame.
        levelRef.current = levelRef.current * 0.7 + boosted * 0.3
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    } catch {
      // Decorativo — sin nivel, la grabación/transcripción sigue funcionando igual.
    }
  }

  /** Corta el rAF y cierra el AudioContext. Idempotente — seguro llamarlo más de una vez
   *  (stop + cleanup de desmontaje pueden pisarse). */
  const stopLevelMonitor = (): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    const ctx = audioContextRef.current
    audioContextRef.current = null
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {
        // Cierre best-effort — si ya estaba cerrándose, no hay nada que hacer.
      })
    }
    levelRef.current = 0
  }

  /** Detiene el publish interval (throttle de nivel/timer/silencio) y el monitor de nivel. */
  const stopMonitoring = (): void => {
    if (publishIntervalRef.current !== null) {
      clearInterval(publishIntervalRef.current)
      publishIntervalRef.current = null
    }
    stopLevelMonitor()
  }

  // Cleanup estricto al desmontar (cambio de conversación/cierre de ventana): soltar el
  // micrófono, cancelar el rAF y cerrar el AudioContext. Dejar un track o un contexto
  // vivo mantiene encendido el indicador de grabación del SO y filtra recursos.
  useEffect(() => {
    return () => {
      stopMonitoring()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetLevelState = (): void => {
    setLevel(0)
    setElapsedSeconds(0)
    setSilence(false)
    silenceStartRef.current = null
  }

  const transcribe = async (blob: Blob, mimeType: string): Promise<void> => {
    if (blob.size === 0) {
      setStatus('idle')
      return
    }
    if (blob.size > MAX_AUDIO_BYTES) {
      setStatus('idle')
      callbacksRef.current.onError('failed')
      return
    }
    setStatus('transcribing')
    try {
      const buffer = await blob.arrayBuffer()
      const result = await window.cerpAPI.transcribeDictation(buffer, mimeType)
      if (result.error === 'auth') {
        // El main ya disparó AUTH_SESSION_EXPIRED (modal global) si el refresh falló.
        callbacksRef.current.onError('session')
        return
      }
      if (result.error) {
        callbacksRef.current.onError('failed')
        return
      }
      const text = typeof result.text === 'string' ? result.text.trim() : ''
      // Vacío (silencio, ruido) no es un error: no hay nada que insertar.
      if (text) callbacksRef.current.onTranscript(text)
    } catch {
      callbacksRef.current.onError('failed')
    } finally {
      setStatus('idle')
    }
  }

  const start = async (): Promise<void> => {
    if (status !== 'idle') return
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      callbacksRef.current.onError('unsupported')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stopMonitoring()
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        resetLevelState()
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
        chunksRef.current = []
        void transcribe(blob, mimeType || 'audio/webm')
      }

      recorderRef.current = recorder
      recorder.start(500)
      setStatus('recording')

      // Arranca el indicador de nivel + timer, en paralelo a la grabación en sí.
      recordStartRef.current = Date.now()
      resetLevelState()
      startLevelMonitor(stream)
      publishIntervalRef.current = setInterval(() => {
        const lvl = levelRef.current
        setLevel(lvl)
        setElapsedSeconds(Math.floor((Date.now() - recordStartRef.current) / 1000))
        if (lvl < SILENCE_LEVEL_THRESHOLD) {
          if (silenceStartRef.current === null) silenceStartRef.current = Date.now()
          setSilence(Date.now() - silenceStartRef.current > SILENCE_HINT_MS)
        } else {
          silenceStartRef.current = null
          setSilence(false)
        }
      }, LEVEL_PUBLISH_INTERVAL_MS)
    } catch (err) {
      setStatus('idle')
      if (err instanceof Error && err.name === 'NotAllowedError') {
        callbacksRef.current.onError('permission')
      } else {
        callbacksRef.current.onError('failed')
      }
    }
  }

  /** Corta la grabación y dispara la transcripción (vía `onstop`). */
  const stop = (): void => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
  }

  return { status, start, stop, level, elapsedSeconds, silence }
}
