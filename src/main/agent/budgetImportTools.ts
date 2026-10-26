import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname, isAbsolute } from 'path'
import { CompanyChangedError, HttpClient, HttpError, NoActiveCompanyError, SessionRevokedError } from '../utils/httpClient'
import { logger } from '../utils/logger'
import { waitForAnswer } from './askUserBridge'
import type { AskUserQuestionItem } from '../ipc/types'

/**
 * IMPORTAR UN PRESUPUESTO TAL CUAL (RQM-150, «CERP IA: importar presupuestos
 * sin alterar el original»).
 *
 * # Por qué existe
 *
 * Importar un Excel del arquitecto o un PDF de adjudicación se hacía con las
 * tools de ARMAR presupuestos: precio por partida del catálogo o del banco,
 * capítulos de la taxonomía del banco, recursos creados a mano. El resultado
 * parecía el presupuesto del cliente pero no lo era (partidas sustituidas,
 * tres niveles aplanados a dos, recursos duplicados, el descompuesto perdido).
 *
 * Esta tool COPIA: manda las filas del archivo al core
 * (`POST /api/budgets/:budgetId/import-rows`), que las materializa con el mismo
 * motor que el import BC3. El modelo no elige partidas ni precios.
 *
 * # Por qué las filas van en un archivo
 *
 * Un presupuesto real son cientos de partidas: retipearlas como argumento de una
 * tool es lento, caro y es justo donde se cuelan los cambios. Las filas las
 * escribe un script de Python (openpyxl) que recorre el Excel celda por celda,
 * como el resto del manejo de Excel del Desktop (excel-analyst), o el modelo al
 * transcribir un PDF, en un JSON local. La tool lo lee como UTF-8 estricto y lo
 * valida con un esquema estricto: una clave mal escrita (`unit_price`) es un
 * error, no un precio perdido en silencio.
 *
 * # Confirmación estructural
 *
 * El agente corre con `permissionMode: 'bypassPermissions'` y las filas salen de
 * un archivo externo, que puede traer texto inyectado: que el prompt mande
 * preguntar no es un freno (ADR 009, regla 4; riesgo DESKTOP_NO_GATE). Por eso
 * `dryRun: false` no escribe directo: el handler pide al core la vista previa
 * con las mismas filas, arma la tarjeta con SUS cifras (no las redacta el
 * modelo), pregunta con `waitForAnswer` y solo con «Importar» exacto hace el
 * POST que escribe. Cancelar, «Otro: …» o cualquier fallo al preguntar = no se
 * escribe nada. Mismo patrón que scheduleTools.ts y appTools.ts.
 *
 * # Contrato con el core
 *
 * - `POST /api/budgets/:budgetId/import-rows` (permiso budgets:edit). El
 *   `companyId` sale de la sesión del JWT (ADR 007). `dryRun` por defecto true.
 * - Idempotencia por contenido: las MISMAS filas en el mismo presupuesto no
 *   duplican nada; otras filas (un JSON corregido) suman partidas.
 */

/** Por debajo del límite de JSON del core (10 MB): cerca del borde llegaría un 413 genérico. */
const MAX_ROWS_FILE_BYTES = 9 * 1024 * 1024
/** Tope de cada lista del resultado: un import de 3000 partidas no puede tapar la nota. */
const MAX_LIST = 50

/**
 * Porcentaje en % (13 = 13 %). El core lee cualquier valor en (0, 100] como
 * porcentaje, y un script que lee la celda «13 %» con openpyxl obtiene 0,13:
 * eso entraría como GG del 0,13 %. Entre 0 y 1 se rechaza.
 */
const percent = z.number().refine((value) => !(value > 0 && value < 1), {
  message:
    'va en % (13 = 13 %), no en tanto por uno: un valor entre 0 y 1 suele ser una celda «13 %» leída como 0,13 (multiplicala por 100). ' +
    'Si el archivo de verdad dice menos de 1 %, dejalo en null y avisale a la persona (en medios auxiliares el core lo deduce del descompuesto)',
})
const text = z.string().nullish()
const amount = z.number().nullish()

const MaterialLineSchema = z.strictObject({
  code: text,
  name: text,
  unit: text,
  quantity: z.number(),
  unitCost: z.number(),
})

const ResourceLineSchema = z.strictObject({
  code: text,
  name: text,
  unit: text,
  quantity: z.number(),
  costRate: z.number(),
})

const RowSchema = z.strictObject({
  index: z.number().int(),
  type: z.enum(['chapter', 'item', 'total']),
  level: z.number().int().min(1).max(32).nullish(),
  code: text,
  name: text,
  unit: text,
  description: text,
  quantity: amount,
  unitPrice: amount,
  amount,
  bom: z
    .strictObject({
      materials: z.array(MaterialLineSchema).nullish(),
      labor: z.array(ResourceLineSchema).nullish(),
      machinery: z.array(ResourceLineSchema).nullish(),
      overheadPercent: percent.nullish(),
    })
    .nullish(),
})

export const RowsFileSchema = z.strictObject({
  rows: z.array(RowSchema).min(1).max(6000),
  declaredTotal: amount,
  currency: text,
  coefficients: z
    .strictObject({
      ci: percent.nullish(),
      gg: percent.nullish(),
      bi: percent.nullish(),
      baja: percent.nullish(),
      iva: percent.nullish(),
    })
    .nullish(),
})

const ImportBudgetRowsSchema = z.object({
  budgetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, 'budgetId: el id del presupuesto (24 caracteres hexadecimales)')
    .describe('ID del presupuesto en borrador donde se importa (de create_budget o get_budget_details).'),
  rowsFile: z
    .string()
    .describe(
      'Ruta ABSOLUTA del JSON (UTF-8) con las filas del archivo, en su orden: { "rows": [...], "declaredTotal"?, "coefficients"?, "currency"? }. ' +
        'Lo escribe un script que lee el Excel celda por celda, o vos al transcribir un PDF. El formato de cada fila está en tus instrucciones (modo importar).',
    ),
  sourceFile: z.string().optional().describe('Ruta del Excel o PDF original. Solo se usa para el nombre y el tipo de archivo.'),
  priceRole: z
    .enum(['cost', 'sale'])
    .optional()
    .describe('"cost" (por defecto): los precios del archivo son de coste. "sale": son de venta (p. ej. un PDF de adjudicación).'),
  priceMode: z
    .enum(['auto', 'unitTotal'])
    .optional()
    .describe('"auto" (por defecto): con descompuesto si el archivo lo trae. "unitTotal": cada partida con su precio unitario total, sin desglosar.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('true (por defecto): vista previa, no escribe nada. false: importa; la tool le muestra a la persona la tarjeta con las cifras y solo escribe si la confirma.'),
})

type RowsFile = z.infer<typeof RowsFileSchema>

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

/** Primeros problemas de validación del JSON, en una línea cada uno (sin volcar el archivo). */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('; ')
}

function sourceKind(path: string | undefined): 'excel' | 'pdf' | undefined {
  const ext = extname(path || '').toLowerCase()
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '.csv') return 'excel'
  if (ext === '.pdf') return 'pdf'
  return undefined
}

/** Lee y valida el JSON de filas. Devuelve el error para el modelo o el contenido. */
function readRowsFile(path: string): { error: string } | { file: RowsFile } {
  if (!isAbsolute(path)) return { error: `rowsFile tiene que ser una ruta ABSOLUTA (recibí «${path}»).` }
  if (!existsSync(path)) return { error: `No existe el archivo de filas: ${path}` }
  if (statSync(path).size > MAX_ROWS_FILE_BYTES) {
    return { error: 'El archivo de filas supera los 9 MB: quitale lo que no es del presupuesto o importalo en dos borradores.' }
  }

  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
  } catch {
    return {
      error:
        'El archivo de filas no está en UTF-8 (las tildes se perderían): escribilo con encoding="utf-8" (en Python: open(ruta, "w", encoding="utf-8") y json.dump(..., ensure_ascii=False)).',
    }
  }

  let json: unknown
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (parseError) {
    return { error: `El archivo de filas no es un JSON válido: ${parseError instanceof Error ? parseError.message : String(parseError)}` }
  }
  const file = RowsFileSchema.safeParse(json)
  if (!file.success) {
    return { error: `El JSON de filas no tiene el formato esperado: ${describeIssues(file.error)}. Corregí el script o el archivo y volvé a llamar.` }
  }
  return { file: file.data }
}

interface ImportRowsResponse {
  dryRun: boolean
  budgetId?: string
  /** Destino legible: lo resuelve el core con la empresa de la sesión. */
  budget?: { id: string; name: string | null; projectName: string | null }
  structure?: { chapters: number; chaptersByLevel: number[]; items: number }
  summary?: Record<string, number>
  totals?: { declared: number | null; computed: number; saleComputed?: number; currency?: string | null; matches: boolean | null }
  coefficients?: { ci: number; gg: number; bi: number; baja: number; iva: number } | null
  salePricing?: { priceRole: 'sale'; factor: number; enabledNow: boolean }
  /** `total.computed` es la suma de partidas del archivo (PEM), también al importar como venta. */
  checks?: { chapters?: Array<{ index: number; declared: number; computed: number }>; total?: { declared: number; computed: number; matches: boolean } | null }
  pendingQuote?: Array<{ row: number; number: string | null }>
  missingQuantity?: Array<{ row: number; number: string | null }>
  derivedPrice?: number[]
  derivedQuantity?: number[]
  anomalies?: unknown[]
  failed?: Array<{ row: number; reason?: string; message?: string }>
  alreadyImported?: number
  warnings?: string[]
  budgetTotals?: unknown
}

/** `{ total, primeras }`: la lista entera solo si es corta. */
function capped<T>(list: T[] | undefined): { total: number; primeras: T[] } {
  const items = list ?? []
  return { total: items.length, primeras: items.slice(0, MAX_LIST) }
}

const fmt = (value: number | null | undefined) =>
  typeof value === 'number' ? value.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

type PriceRole = 'cost' | 'sale'

/**
 * El K del archivo y qué hace con él el core (según `costItemsApplied` y
 * `salePricing.factor` de su respuesta, no según el modelo). Va separado del
 * IVA: uno puede aplicarse y el otro no.
 */
function kLine(res: ImportRowsResponse, file: RowsFile, priceRole: PriceRole): string {
  const c = file.coefficients
  const parts = [c?.ci ? `CI ${c.ci} %` : '', c?.gg ? `GG ${c.gg} %` : '', c?.bi ? `BI ${c.bi} %` : ''].filter(Boolean)
  if (priceRole === 'sale') {
    const factor = res.salePricing?.factor ?? 1
    return factor !== 1
      ? `${parts.join(', ')} del archivo: la venta de cada partida es su precio × ${factor.toLocaleString('es-ES', { maximumFractionDigits: 4 })}`
      : 'el archivo no trae GG ni BI: la venta de cada partida es su precio del archivo'
  }
  if (parts.length === 0) return 'el archivo no trae K: queda el del presupuesto (el total de venta depende de él)'
  return `${parts.join(', ')} del archivo: ${(res.summary?.costItemsApplied ?? 0) > 0 ? 'se aplica al presupuesto' : 'no se aplica (ver avisos)'}`
}

/** El IVA del archivo y si el core lo aplica (`taxesApplied`). */
function ivaLine(res: ImportRowsResponse, file: RowsFile): string {
  const iva = file.coefficients?.iva
  if (!iva) return 'el archivo no trae IVA: quedan los impuestos del presupuesto'
  return `IVA ${iva} % del archivo: ${(res.summary?.taxesApplied ?? 0) > 0 ? 'se aplica al presupuesto' : 'no se aplica (ver avisos)'}`
}

/**
 * Total del archivo contra la suma de sus partidas (PEM). El «cuadra» del core
 * compara siempre eso, también al importar como venta: la venta va aparte.
 */
function totalLine(res: ImportRowsResponse, priceRole: PriceRole): string {
  const t = res.totals
  if (!t) return '—'
  const pem = res.checks?.total?.computed ?? (priceRole === 'sale' ? null : t.computed)
  const parts = [`archivo ${fmt(t.declared)}`]
  if (pem != null) parts.push(`partidas ${fmt(pem)}`)
  if (t.matches === false) parts.push('NO CUADRA')
  else if (t.matches) parts.push('cuadra')
  return parts.join(' · ')
}

/** Resultado para el modelo: la nota y el aviso primero, las listas recortadas. */
function shapeResult(res: ImportRowsResponse, file: RowsFile, priceRole: PriceRole, nota: string) {
  const totalsMismatch = res.totals?.matches === false
  const chapterMismatches = (res.checks?.chapters ?? []).filter((c) => Math.abs(c.declared - c.computed) > 0.01)
  const s = res.summary ?? {}
  return {
    nota,
    ...(totalsMismatch ? { aviso: 'La suma de las partidas no coincide con el total que declara el archivo: decíselo a la persona.' } : {}),
    dryRun: res.dryRun,
    destino: res.budget,
    estructura: res.structure,
    total: totalLine(res, priceRole),
    ...(priceRole === 'sale' ? { ventaCalculada: res.totals?.saleComputed ?? res.totals?.computed ?? null } : {}),
    k: kLine(res, file, priceRole),
    iva: ivaLine(res, file),
    catalogo: {
      productosNuevos: s.productsCreated ?? 0,
      productosReutilizados: (s.productsReused ?? 0) + (s.productsRevived ?? 0),
      materialesNuevos: s.materialsCreated ?? 0,
      recursosNuevos: s.resourcesCreated ?? 0,
      impuestosAplicados: s.taxesApplied ?? 0,
      conceptosKAplicados: s.costItemsApplied ?? 0,
    },
    capitulosQueNoCuadran: capped(chapterMismatches),
    pendientesDeCotizar: capped(res.pendingQuote),
    sinMedicion: capped(res.missingQuantity),
    precioDeducido: res.derivedPrice?.length ?? 0,
    cantidadDeducida: res.derivedQuantity?.length ?? 0,
    rarezas: capped(res.anomalies),
    fallidas: capped(res.failed),
    yaImportadas: res.alreadyImported ?? 0,
    avisos: capped(res.warnings),
  }
}

// ── Confirmación (waitForAnswer) ─────────────────────────────────────────────

const IMPORT_OPTION = 'Importar'
const CANCEL_OPTION = 'Cancelar'
const MAX_QUESTION_CHARS = 1500

type ConfirmOutcome = { confirmed: true } | { confirmed: false; reason: 'cancelled_by_user' | 'not_confirmed'; mensaje: string }

/** «Archivo» lo indica el modelo (ruta que eligió): se marca como tal y se recorta. */
function fileLabel(fileName: string): string {
  return fileName.length > 80 ? `${fileName.slice(0, 79)}…` : fileName
}

/**
 * La tarjeta con las cifras de la vista previa del CORE. El destino también lo
 * resuelve el core; lo único que viene del modelo es el nombre del archivo, y
 * se rotula así.
 */
function importQuestion(
  preview: ImportRowsResponse,
  destination: { name: string; projectName: string | null },
  fileName: string,
  file: RowsFile,
  priceRole: PriceRole,
): AskUserQuestionItem {
  const st = preview.structure
  const s = preview.summary ?? {}
  const fields: Array<{ label: string; value: string }> = [
    {
      label: 'Destino',
      value: `presupuesto «${destination.name}»${destination.projectName ? ` del proyecto «${destination.projectName}»` : ''}`,
    },
    {
      label: 'Estructura',
      value: st ? `${st.chapters} capítulos (${st.chaptersByLevel.map((n, i) => `nivel ${i + 1}: ${n}`).join(', ')}) y ${st.items} partidas` : '—',
    },
    { label: 'Total', value: totalLine(preview, priceRole) },
  ]
  if (priceRole === 'sale') fields.push({ label: 'Venta calculada', value: fmt(preview.totals?.saleComputed ?? preview.totals?.computed) })
  fields.push(
    { label: 'Pendientes de cotizar', value: String(preview.pendingQuote?.length ?? 0) },
    { label: 'Sin medición (cantidad 1)', value: String(preview.missingQuantity?.length ?? 0) },
    {
      label: 'Nuevos en el catálogo',
      value: `${s.productsCreated ?? 0} productos, ${s.materialsCreated ?? 0} materiales, ${s.resourcesCreated ?? 0} recursos`,
    },
    { label: 'K', value: kLine(preview, file, priceRole) },
    { label: 'IVA', value: ivaLine(preview, file) },
  )
  if (preview.alreadyImported) fields.push({ label: 'Ya importadas (no se duplican)', value: String(preview.alreadyImported) })
  if (preview.failed?.length) fields.push({ label: 'Fallarían', value: String(preview.failed.length) })
  if (preview.anomalies?.length) fields.push({ label: 'Rarezas del original', value: String(preview.anomalies.length) })
  if (preview.warnings?.length) fields.push({ label: 'Avisos', value: preview.warnings.slice(0, 3).join(' · ') })
  fields.push({ label: 'Archivo (según CERP IA)', value: fileLabel(fileName) })

  const title = priceRole === 'sale' ? 'Importar el presupuesto tal cual, con sus precios como VENTA' : 'Importar el presupuesto tal cual'
  const text = `${title} — ${fields.map((f) => `${f.label}: ${f.value}`).join(' · ')}. ¿Importar?`
  return {
    question: text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS - 1)}…` : text,
    header: 'Importar',
    multiSelect: false,
    options: [
      { label: IMPORT_OPTION, description: 'Escribe los capítulos y las partidas en el presupuesto en borrador.' },
      { label: CANCEL_OPTION, description: 'No se escribe nada.' },
    ],
    card: { title, fields },
  }
}

/**
 * Pregunta en la conversación del usuario y espera. Solo «Importar» exacto
 * confirma: cancelar, «Otro: …», vacío o cualquier fallo al preguntar = no
 * confirmado. Nunca lanza.
 */
async function confirmWithUser(conversationId: string, question: AskUserQuestionItem, logTag: string): Promise<ConfirmOutcome> {
  let answer: string
  try {
    const answers = await waitForAnswer(conversationId, { questions: [question] })
    const raw = answers[question.question] ?? Object.values(answers)[0]
    answer = (Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`${logTag}: sin confirmacion (${message}) — no se importa`)
    return {
      confirmed: false,
      reason: 'not_confirmed',
      mensaje: `No se pudo pedir la confirmación al usuario (${message}). No se importó nada.`,
    }
  }

  if (answer === IMPORT_OPTION) return { confirmed: true }

  const otro = answer.startsWith('Otro:') ? answer.slice('Otro:'.length).trim() : ''
  logger.info(`${logTag}: el usuario no confirmo (${answer || 'sin respuesta'})`)
  return {
    confirmed: false,
    reason: 'cancelled_by_user',
    mensaje: otro
      ? `El usuario no importó y respondió: "${otro}". No se escribió nada; preguntale qué cambiar.`
      : 'El usuario canceló la importación. No se escribió nada; no la reintentes sin que lo pida.',
  }
}

// ── Errores del core ─────────────────────────────────────────────────────────

function coreError(err: HttpError): { code?: string; message?: string } {
  const body = err.body as { error?: { code?: string; message?: string } | string } | undefined
  if (typeof body?.error === 'string') return { message: body.error }
  return { code: body?.error?.code, message: body?.error?.message }
}

function describeImportError(err: unknown): string {
  // Sesión y empresa: ya traen el texto para el modelo (y nunca se reintentan).
  if (err instanceof CompanyChangedError || err instanceof NoActiveCompanyError || err instanceof SessionRevokedError) return err.message
  if (!(err instanceof HttpError)) return err instanceof Error ? err.message : String(err)

  const { code, message } = coreError(err)
  switch (code) {
    case 'SALE_PRICING_LEGACY':
      return (
        'Este presupuesto calcula la venta con el coeficiente K global: no admite importar los precios como venta. ' +
        'Opciones para la persona: importarlos como coste, o activar «precio de venta por partida» en el borrador desde el ERP. NO reintentes igual.'
      )
    case 'BUDGET_NOT_DRAFT':
      return 'El presupuesto no está en borrador (o es una versión anterior): no admite importar. Hay que hacerlo sobre un borrador. NO reintentes igual.'
    case 'BUDGET_FROZEN':
      return `El presupuesto está aprobado y congelado: no admite importar.${message ? ` (${message})` : ''} NO reintentes igual.`
    case 'CURRENCY_MISMATCH':
      return `La moneda del archivo no coincide con la del presupuesto: ${message ?? 'revisala con la persona'}. NO reintentes igual.`
  }
  if (err.status === 403) return message ?? 'Este usuario no tiene permiso de edición sobre presupuestos. Decíselo y no reintentes.'
  if (err.status === 404) {
    return code === 'NOT_FOUND'
      ? 'No existe ese presupuesto en la empresa activa: revisá el budgetId (get_budget_by_project).'
      : 'El servidor de CERP todavía no tiene la importación fiel de presupuestos. Avisale a la persona y no intentes importar con otras tools: el resultado alteraría el original.'
  }
  if (err.status === 400) return `El servidor rechazó las filas: ${message ?? err.message}. Corregí el JSON y volvé a llamar.`
  if (err.status === 413) return 'El servidor rechazó el archivo de filas por tamaño: importalo en dos borradores.'
  if (err.status === 409) return `El servidor rechazó la importación (${code ?? '409'}): ${message ?? err.message}. NO reintentes igual.`
  return message ?? err.message
}

export function createBudgetImportTools(httpClient: HttpClient, conversationId: string) {
  const importBudgetRowsTool = tool(
    'import_budget_rows',
    'Importa un presupuesto que YA EXISTE (Excel o PDF del arquitecto, PDF de adjudicación, export de otro programa) TAL CUAL: ' +
      'mismos capítulos, subcapítulos, partidas, códigos, nombres, cantidades, descripciones, descompuesto y precios. El precio es el del ' +
      'archivo: nunca se reemplaza una partida por otra del banco ni del catálogo. Recibe las FILAS del archivo en un JSON local (rowsFile, ruta absoluta). ' +
      'Primero llamala con dryRun true (vista previa, no escribe) y contale a la persona el resumen; después llamala con dryRun false: la tool le muestra ' +
      'la tarjeta con las cifras y solo escribe si la persona la confirma. Sin medición → cantidad 1; sin precio → 0 y «Pendiente de cotizar»; ' +
      'las rarezas del original se conservan y se informan. Las MISMAS filas en el mismo presupuesto no duplican nada; otras filas (un JSON corregido) ' +
      'SUMAN partidas. NO uses esta tool para ARMAR un presupuesto nuevo.',
    ImportBudgetRowsSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = ImportBudgetRowsSchema.safeParse(args)
        if (!parsed.success) return errorResult(describeIssues(parsed.error))
        const input = parsed.data

        const read = readRowsFile(input.rowsFile)
        if ('error' in read) return errorResult(read.error)
        const file = read.file
        const fileHasCoefficients = file.coefficients != null && Object.values(file.coefficients).some((v) => v != null)

        const fileName = basename(input.sourceFile || input.rowsFile)
        const kind = sourceKind(input.sourceFile)
        const priceRole: PriceRole = input.priceRole ?? 'cost'
        const body = (dryRun: boolean) => ({
          dryRun,
          priceRole,
          priceMode: input.priceMode ?? 'auto',
          rows: file.rows,
          ...(file.declaredTotal != null ? { declaredTotal: file.declaredTotal } : {}),
          ...(file.currency ? { currency: file.currency } : {}),
          ...(fileHasCoefficients ? { coefficients: file.coefficients } : {}),
          source: { fileName, ...(kind ? { kind } : {}) },
        })
        const url = `/budgets/${input.budgetId}/import-rows`

        // Vista previa: siempre primero, también antes de escribir (es lo que se confirma).
        const preview = (await httpClient.post(url, body(true))) as ImportRowsResponse
        if (input.dryRun !== false) {
          logger.info(`import_budget_rows dryRun: budget ${input.budgetId}, ${preview.structure?.items ?? '?'} partidas`)
          return textResult(
            shapeResult(
              preview,
              file,
              priceRole,
              'VISTA PREVIA: no se escribió nada. Contale a la persona el destino, los capítulos por nivel, las partidas, el total del archivo contra la suma de partidas, ' +
                'las pendientes de cotizar, las que no tenían medición, el K y el IVA, lo nuevo en el catálogo y las rarezas (por número de fila). ' +
                'Si el total no cuadra, revisá el script o la transcripción ANTES de importar. Para importar, llamá de nuevo con dryRun:false: ' +
                'la tool le muestra la tarjeta para confirmar (no la preguntes vos con ask_user_question).',
            ),
          )
        }

        const items = preview.structure?.items ?? 0
        if (items > 0 && (preview.alreadyImported ?? 0) >= items) {
          return textResult(
            shapeResult(preview, file, priceRole, 'Estas filas ya estaban importadas en este presupuesto: no había nada nuevo que escribir y no se escribió nada.'),
          )
        }

        // Sin destino resuelto por el core no se pregunta: la persona tiene que ver adónde se escribe.
        const destination = preview.budget?.name ? { name: preview.budget.name, projectName: preview.budget.projectName ?? null } : null
        if (!destination) {
          return errorResult('El servidor no confirmó el nombre del presupuesto destino: no se importó nada. Revisá el budgetId con get_budget_by_project.')
        }
        const question = importQuestion(preview, destination, fileName, file, priceRole)
        const outcome = await confirmWithUser(conversationId, question, `import_budget_rows[${input.budgetId}]`)
        if (!outcome.confirmed) return textResult({ imported: false, reason: outcome.reason, mensaje: outcome.mensaje })

        // `approved`: la persona confirmó en la tarjeta. El core lo registra (ADR 021, modo shadow).
        const res = (await httpClient.post(url, { ...body(false), approved: true })) as ImportRowsResponse
        const failed = res.failed?.length ?? 0
        const already = res.alreadyImported ?? 0
        logger.info(`import_budget_rows OK: budget ${input.budgetId}, ${res.structure?.items ?? '?'} partidas, ${failed} fallidas, ${already} ya importadas`)
        const nota =
          failed > 0
            ? `Importación PARCIAL: ${failed} partida(s) fallaron (ver fallidas). Contale cuáles y por qué: no digas que se importó todo.`
            : `Importado tal cual${already > 0 ? ` (${already} partida(s) ya estaban importadas y no se duplicaron)` : ''}. ` +
              'No cambies el K ni los impuestos salvo que la persona lo pida (ver k e iva). Las partidas sin precio quedan marcadas «Pendiente de cotizar».'
        return textResult(shapeResult(res, file, priceRole, nota))
      } catch (err) {
        const message = describeImportError(err)
        logger.error(`import_budget_rows FAILED: ${err instanceof Error ? err.message : String(err)}`)
        return errorResult(message)
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  return [importBudgetRowsTool]
}
