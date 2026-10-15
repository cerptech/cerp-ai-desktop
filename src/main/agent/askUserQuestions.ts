/**
 * Normaliza las preguntas que manda el agente por `ask_user_question` antes de
 * mostrarlas en el widget.
 *
 * El schema de la tool es tolerante a propósito: una pregunta que no pasaba la
 * validación (p.ej. un header de más de 12 caracteres, una opción sin descripción o 5
 * opciones) no llegaba al widget y el agente quedaba anunciando preguntas que el
 * usuario nunca veía (Camacho, 2026-09). Lo que el widget puede dibujar se acepta y se
 * deja acá en la forma que espera el renderer.
 *
 * Función pura: sin Electron, para poder probarla aislada.
 */
import type { AskUserQuestionItem } from '../ipc/types'

export interface RawQuestionOption {
  label: string
  description?: string
}

export interface RawQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: RawQuestionOption[]
}

/** El chip del header es chico: más que esto se corta con "…". */
export const HEADER_MAX_CHARS = 24

function clip(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Hace únicos los textos repetidos ("X", "X (2)"…): el widget y la respuesta se indexan por texto. */
function uniquify(values: string[]): string[] {
  const seen = new Map<string, number>()
  return values.map((v) => {
    const n = (seen.get(v) ?? 0) + 1
    seen.set(v, n)
    return n === 1 ? v : `${v} (${n})`
  })
}

export function normalizeQuestions(raw: RawQuestion[]): AskUserQuestionItem[] {
  const texts = uniquify(raw.map((q) => q.question.trim()))
  return raw.map((q, i) => {
    const labels = uniquify(q.options.map((o) => o.label.trim()))
    return {
      question: texts[i],
      header: clip(q.header?.trim() || (raw.length > 1 ? `Pregunta ${i + 1}` : 'Pregunta'), HEADER_MAX_CHARS),
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o, j) => ({ label: labels[j], description: o.description?.trim() ?? '' })),
    }
  })
}
