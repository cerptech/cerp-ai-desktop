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
 * `AnalyserNode` sobre el mismo `MediaStream` de `getUserMedia` se muestrea
 * DENTRO del propio `setInterval` de 150ms que publica el nivel — sin un loop de
 * `requestAnimationFrame` aparte. Se probó primero con rAF (60fps) escribiendo a
 * un ref y publicando cada 150ms para no re-renderizar de más, pero rAF se
 * congela en cuanto la ventana se minimiza o pierde foco (es lo que hace que
 * `requestAnimationFrame` sea "gratis" para el navegador) — con la ventana
 * minimizada el nivel se quedaba clavado, el silencio artificial disparaba el
 * hint de "no se detecta audio" con el usuario hablando normal. `setInterval`
 * no tiene ese throttling agresivo en Electron, así que es el único reloj: cada
 * tick lee el analyser, calcula RMS y publica todo junto (nivel, timer, silencio).
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

/** Cada cuánto se mide el analyser y se publica el nivel (ms). */
const LEVEL_PUBLISH_INTERVAL_MS = 150

/** Nivel por debajo del cual se considera "silencio" para el hint de "no se detecta audio". */
const SILENCE_LEVEL_THRESHOLD = 0.02

/** Cuánto silencio sostenido antes de mostrar el hint ambar. */
const SILENCE_HINT_MS = 3000

export function useDictation({ onTranscript, onError }: UseDictationOptions) {
  const [status, setStatus] = useState<DictationStatus>('idle')
  // Nivel de micrófono 0-1, muestreado y publicado cada LEVEL_PUBLISH_INTERVAL_MS
  // (ver comentario de arriba — nada de rAF). Segundos transcurridos de la grabación.
  const [level, setLevel] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  // true cuando el nivel se mantuvo ~0 por más de SILENCE_HINT_MS seguidos.
  const [silence, setSilence] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  // Guard sincrónico contra doble arranque: dos clicks mientras el prompt nativo
  // de permisos de micrófono está abierto (el `await getUserMedia` puede tardar
  // varios segundos) antes se colaban los dos — `status` seguía en 'idle' porque
  // `setStatus('recording')` recién corre DESPUÉS de que el usuario responde el
  // prompt, así que el chequeo `status !== 'idle'` no alcanzaba a bloquear el
  // segundo click. Resultado: dos MediaRecorder + dos AudioContext + dos streams
  // de micrófono abiertos, y solo uno queda referenciado — el otro fugaba para
  // siempre (mic prendido sin forma de apagarlo desde la UI). `startingRef` se
  // prende ANTES del primer `await` y se apaga en el `finally`.
  const startingRef = useRef(false)

  // ── Medición de nivel: AudioContext + AnalyserNode, sin rAF (ver arriba) ────
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const publishIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const silenceStartRef = useRef<number | null>(null)
  const recordStartRef = useRef(0)

  // Callbacks por ref para que start/stop sean estables sin exigirle al caller
  // memoizar los suyos. Se actualiza en un effect (no durante el render).
  const callbacksRef = useRef({ onTranscript, onError })
  useEffect(() => {
    callbacksRef.current = { onTranscript, onError }
  })

  /** Arranca el AudioContext + AnalyserNode sobre el stream (sin loop propio — el
   *  setInterval de `start()` es el único que lo muestrea). Best-effort: si el
   *  AudioContext falla (política de autoplay, browser raro), la grabación sigue
   *  igual — el nivel es un adorno visual, no crítico. */
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
      analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount)
    } catch {
      // Decorativo — sin nivel, la grabación/transcripción sigue funcionando igual.
    }
  }

  /** Lee el analyser UNA vez y devuelve el nivel 0-1 (RMS con ganancia, clamp a 1).
   *  0 si no hay analyser (AudioContext falló o todavía no arrancó). */
  const sampleLevel = (): number => {
    const analyser = analyserRef.current
    const data = analyserDataRef.current
    if (!analyser || !data) return 0
    analyser.getByteTimeDomainData(data)
    // RMS de la waveform normalizada a -1..1 (128 = silencio absoluto en unsigned 8-bit).
    let sumSquares = 0
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128
      sumSquares += normalized * normalized
    }
    const rms = Math.sqrt(sumSquares / data.length)
    // Ganancia x4 para que un volumen de voz normal llene la barra.
    return Math.min(1, rms * 4)
  }

  /** Cierra el AudioContext. Idempotente — seguro llamarlo más de una vez (stop +
   *  cleanup de desmontaje pueden pisarse). */
  const stopLevelMonitor = (): void => {
    analyserRef.current = null
    analyserDataRef.current = null
    const ctx = audioContextRef.current
    audioContextRef.current = null
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {
        // Cierre best-effort — si ya estaba cerrándose, no hay nada que hacer.
      })
    }
  }

  /** Detiene el publish interval (nivel/timer/silencio) y el monitor de nivel. */
  const stopMonitoring = (): void => {
    if (publishIntervalRef.current !== null) {
      clearInterval(publishIntervalRef.current)
      publishIntervalRef.current = null
    }
    stopLevelMonitor()
  }

  // Cleanup estricto al desmontar (cambio de conversación/cierre de ventana): soltar el
  // micrófono, cortar el interval y cerrar el AudioContext. Dejar un track o un contexto
  // vivo mantiene encendido el indicador de grabación del SO y filtra recursos.
  useEffect(() => {
    return () => {
      stopMonitoring()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
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
    if (status !== 'idle' || startingRef.current) return
    startingRef.current = true
    try {
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        callbacksRef.current.onError('unsupported')
        return
      }
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
        const lvl = sampleLevel()
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
      // Si el MediaRecorder tiró DESPUÉS de que getUserMedia ya entregó el
      // stream (o el monitor de nivel llegó a arrancar), no dejar el micrófono
      // abierto sin nada que lo cierre — antes este catch solo hacía
      // setStatus('idle') y el track quedaba vivo (indicador de grabación del SO
      // prendido para siempre hasta cerrar la app).
      stopMonitoring()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setStatus('idle')
      if (err instanceof Error && err.name === 'NotAllowedError') {
        callbacksRef.current.onError('permission')
      } else {
        callbacksRef.current.onError('failed')
      }
    } finally {
      startingRef.current = false
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
