import { useEffect, useRef, useState } from 'react'

/**
 * useDictation — dictado por voz del composer (Ola 1).
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

export function useDictation({ onTranscript, onError }: UseDictationOptions) {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  // Callbacks por ref para que start/stop sean estables sin exigirle al caller
  // memoizar los suyos. Se actualiza en un effect (no durante el render).
  const callbacksRef = useRef({ onTranscript, onError })
  useEffect(() => {
    callbacksRef.current = { onTranscript, onError }
  })

  // Al desmontar (cambio de conversación/cierre de ventana) se suelta el micrófono:
  // dejar un track vivo mantiene encendido el indicador de grabación del SO.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

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
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
        chunksRef.current = []
        void transcribe(blob, mimeType || 'audio/webm')
      }

      recorderRef.current = recorder
      recorder.start(500)
      setStatus('recording')
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

  return { status, start, stop }
}
