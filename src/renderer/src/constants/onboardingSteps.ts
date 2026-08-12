// Contenido del tutorial guiado de 6 pasos del Desktop (Idea 1 — "Cómo empezar").
// El copy vive acá (centralizado, sin jerga técnica); la interactividad de cada
// paso (conectar carpeta, elegir prompt) la resuelve OnboardingWizard.tsx.

export const ONBOARDING_TOTAL_STEPS = 6

export interface OnboardingStepMeta {
  /** 1..6 — debe coincidir con el backend (DesktopOnboarding). */
  id: number
  title: string
  /** Bajada corta que aparece bajo el título. */
  tagline: string
  /** Emoji ilustrativo del paso. */
  icon: string
}

export const ONBOARDING_STEPS: OnboardingStepMeta[] = [
  { id: 1, title: 'Qué puede hacer CERP AI', tagline: 'Tu asistente para cotizaciones y licitaciones de obra.', icon: '\u{1F44B}' },
  { id: 2, title: 'Prepara tu data', tagline: 'Ten a mano los archivos que la IA va a usar.', icon: '\u{1F4C1}' },
  { id: 3, title: 'Conecta tu carpeta de trabajo', tagline: 'Apunta la app a la carpeta donde están tus archivos.', icon: '\u{1F517}' },
  { id: 4, title: 'Tu primer pedido', tagline: 'Elige un punto de partida y edítalo a tu gusto.', icon: '\u{1F4AC}' },
  { id: 5, title: 'Cómo leer la respuesta', tagline: 'Entiende qué te devuelve el agente.', icon: '\u{1F4D6}' },
  { id: 6, title: 'Próximos pasos', tagline: 'Exporta, comparte y refina tu cotización.', icon: '\u{1F680}' },
]

// ── Paso 1: 3 ejemplos de lo que puede hacer ──
export interface OnboardingExample {
  icon: string
  title: string
  description: string
}

export const ONBOARDING_EXAMPLES: OnboardingExample[] = [
  { icon: '\u{1F4E5}', title: 'Importar catálogo', description: 'Carga tu catálogo de materiales y recursos desde Excel para tenerlo disponible en tus cotizaciones.' },
  { icon: '\u{1F9F1}', title: 'Generar APUs desde plantilla', description: 'A partir de una plantilla, la IA arma los Análisis de Precio Unitario de cada partida.' },
  { icon: '\u{1F4CB}', title: 'Cotizar una licitación', description: 'Analiza un pliego completo y genera el presupuesto con capítulos, ítems y totales.' },
]

// ── Paso 2: checklist de data ──
export interface OnboardingChecklistItem {
  label: string
  hint: string
  required: boolean
}

export const ONBOARDING_CHECKLIST: OnboardingChecklistItem[] = [
  { label: 'Catálogo de materiales', hint: 'Excel con materiales, mano de obra y equipos con sus precios.', required: false },
  { label: 'Plantilla de APU', hint: 'Tu formato de Análisis de Precio Unitario, si ya tienes uno.', required: false },
  { label: 'Pliego / archivos de la obra', hint: 'El pliego de licitación o los planos y cómputos de la obra.', required: true },
]

// ── Paso 5: glosario para leer la respuesta ──
export interface OnboardingGlossaryTerm {
  term: string
  definition: string
}

export const ONBOARDING_GLOSSARY: OnboardingGlossaryTerm[] = [
  { term: 'Capítulo', definition: 'Una agrupación de partidas dentro del presupuesto (ej. "Movimiento de suelos").' },
  { term: 'Ítem / Partida', definition: 'Cada tarea concreta a cotizar dentro de un capítulo, con su cantidad y unidad.' },
  { term: 'APU', definition: 'Análisis de Precio Unitario: el desglose de materiales, mano de obra y equipos que componen el precio de un ítem.' },
  { term: 'Total', definition: 'La suma de todos los ítems. Revisa que cada capítulo tenga ítems y que el total sea mayor a 0.' },
]

// ── Paso 6: próximos pasos ──
export const ONBOARDING_NEXT_STEPS: string[] = [
  'Exporta tu cotización a PDF para enviarla a tu cliente.',
  'Pídele a la IA que ajuste cantidades, precios o márgenes y vuelve a generar.',
  'Adjunta un PDF al chat para sumarlo a la cotización.',
  'Empieza una nueva conversación para cada obra distinta.',
]
