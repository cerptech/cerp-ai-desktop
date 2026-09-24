import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Tools de CARGA DE DOCUMENTOS: una factura de proveedor, una factura de cliente
 * o un ticket de gasto en PDF se convierten en el registro correspondiente en CERP.
 *
 * # Duplicado a propósito del flujo de WhatsApp
 *
 * Es el mismo flujo que `cerp-server/src/agents/whatsapp/tools.ts`
 * (`check_invoice_items_catalog`, `create_supplier_invoice_from_whatsapp`,
 * `create_client_invoice_from_whatsapp`, `create_expense_from_whatsapp`,
 * `create_contact_from_whatsapp`). Aquellas corren dentro del core con acceso
 * directo a Mongo y leen el archivo del último mensaje de WhatsApp; acá no hay
 * base de datos, así que la misma secuencia se arma sobre la API REST con el
 * token del usuario. El core sigue aplicando empresa y permisos en cada ruta
 * (ADR 007): ninguna de estas tools manda `companyId`.
 *
 * Si cambia una regla de negocio en una de las dos versiones, hay que llevarla
 * a la otra.
 *
 * # Diferencias con WhatsApp
 *
 * - **No hay tool de extracción.** El agente lee el PDF con `Read` en la máquina:
 *   el documento no pasa por el servidor antes de que el usuario confirme.
 * - **Solo PDF.** `POST /supplier-invoices/:id/pdf` rechaza cualquier otro tipo.
 * - **Cada línea de la factura de proveedor necesita `itemId`.** Vía REST la
 *   factura nace con `source: 'manual'` y el modelo exige el ítem en cada línea
 *   (`SupplierInvoice.ts`, pre-validate). WhatsApp guarda la línea sin vincular
 *   si no puede crear el ítem; acá se corta ANTES de crear la factura.
 * - **La factura de cliente no lleva adjunto**: no existe endpoint para subirlo.
 * - **No hay borrador de rescate.** Si la creación falla, el agente le muestra
 *   al usuario los datos extraídos para cargarlos a mano (ver systemPrompt.ts).
 */

const APP_BASE_URL = 'https://app.cerp.es'
const DOCS_SUPPLIER_INVOICE_MANUAL_URL = 'https://docs.cerp.es/docs/compras/facturas-de-proveedor'
const DOCS_CLIENT_INVOICE_MANUAL_URL = 'https://docs.cerp.es/docs/ventas/facturas'
const DOCS_EXPENSE_MANUAL_URL = 'https://docs.cerp.es/docs/finanzas/registrar-gastos'

// Límites de multer en el core: pdfUploadConfig.ts (20 MB) y expenseRoutes.ts (10 MB).
const MAX_SUPPLIER_INVOICE_PDF_BYTES = 20 * 1024 * 1024
const MAX_EXPENSE_ATTACHMENT_BYTES = 10 * 1024 * 1024

// Mismo listado que ALLOWED_EXPENSE_CATEGORIES en cerp-server/src/controllers/expenseController.ts.
const EXPENSE_CATEGORIES = ['gastos', 'materiales', 'mano_de_obra', 'herramientas', 'transporte', 'servicios', 'otros'] as const

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
}

/** Mensaje legible de un error de la API: el core responde `{ error: { message } }` o `{ error: '...' }`. */
function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string; code?: string } | string } | undefined
    const apiMessage = typeof body?.error === 'string' ? body.error : body?.error?.message
    if (err.status === 403) return `Sin permiso para esta acción (${apiMessage ?? '403'}).`
    return apiMessage ? `${apiMessage} (HTTP ${err.status})` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | undefined {
  if (!(err instanceof HttpError)) return undefined
  const body = err.body as { error?: { code?: string } } | undefined
  return body?.error?.code
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const normalizeText = (s: string | undefined | null) => String(s ?? '').trim().toLowerCase()

/** Valida que la ruta sea un PDF existente y dentro del tamaño aceptado por el endpoint. */
function checkPdf(filePath: string, maxBytes: number): string | null {
  if (!existsSync(filePath)) return `Archivo no encontrado: ${filePath}`
  if (extname(filePath).toLowerCase() !== '.pdf') {
    return 'Solo se aceptan documentos en PDF. Pedile al usuario el PDF de la factura o del ticket.'
  }
  const size = statSync(filePath).size
  if (size > maxBytes) {
    return `El PDF pesa ${(size / (1024 * 1024)).toFixed(1)} MB y el máximo es ${maxBytes / (1024 * 1024)} MB.`
  }
  return null
}

function pdfFormData(filePath: string, field: string): FormData {
  const formData = new FormData()
  formData.append(field, new Blob([readFileSync(filePath)], { type: 'application/pdf' }), basename(filePath))
  return formData
}

/**
 * Código de catálogo para un ítem creado desde una factura. `POST /items` exige
 * `code` y lo quiere único por empresa (contando los borrados, ADR 013), así que
 * se arma con el nombre más un sufijo aleatorio.
 */
function generateItemCode(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `FAC-${slug || 'ITEM'}-${suffix}`
}

const objectId = (label: string) => z.string().regex(/^[a-f0-9]{24}$/i, `${label} debe ser un ID de CERP (24 caracteres hex)`)

const ExtractedLineSchema = z.object({
  description: z.string().describe('Descripción de la línea tal como aparece en el documento'),
  quantity: z.number().optional().describe('Cantidad. Si no figura, 1'),
  unit: z.string().optional().describe('Unidad (ud, kg, m2...)'),
  unitCost: z.number().optional().describe('Precio unitario SIN impuestos'),
  taxRate: z.number().optional().describe('IVA de la línea en porcentaje, ej. 21'),
})

const ExtractedInvoiceSchema = z.object({
  vendor: z.string().optional().describe('Nombre del emisor'),
  taxId: z.string().optional().describe('CIF/NIF/CUIT del emisor'),
  invoiceNumber: z.string().optional().describe('Número de factura'),
  issueDate: z.string().optional().describe('Fecha de emisión, ISO YYYY-MM-DD'),
  dueDate: z.string().optional().describe('Vencimiento, ISO YYYY-MM-DD'),
  currency: z.string().optional().describe('Código ISO de moneda'),
  items: z.array(ExtractedLineSchema).min(1).describe('Líneas de detalle. Si el documento no las desglosa, UNA línea con la descripción general y el importe total'),
  subtotal: z.number().optional(),
  taxAmount: z.number().optional(),
  totalAmount: z.number().optional().describe('Total de la factura según el documento'),
})

const CheckCatalogSchema = z.object({
  lines: z.array(z.object({
    description: z.string().describe('Descripción de la línea tal como figura en la factura'),
    searchTerms: z.array(z.string()).optional().describe(
      'Nombres o códigos que el USUARIO te dio para esta línea ("caja estanco", "INT-25A"), tal cual los escribió. Se buscan primero y sus resultados van arriba.',
    ),
  })).min(1).describe('Las líneas de la factura, en el mismo orden en que se las mostraste al usuario'),
})

// ── Búsqueda de artículos por nombre ─────────────────────────────────────────
//
// `GET /items?search=` compara el texto como SUBSTRING de nombre, código,
// descripción y código de proveedor (itemsController.getAllItems). Mandarle la
// descripción entera de una línea casi nunca encuentra nada: "Caja exterior Taad
// 115x115x80" no es substring de "Caja estanco Taad 115X115X80" por una palabra.
// Pasó con un cliente cuatro veces seguidas: el agente decía "no existe" y
// proponía crear materiales que ya estaban cargados.
//
// Por eso se busca también por cada palabra clave de la línea (medidas, marca,
// palabras largas), se juntan los resultados y se ordenan por cuántas palabras
// de la línea coinciden con el nombre o el código del artículo.

const STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'para', 'con', 'sin', 'por', 'en', 'y', 'o', 'al', 'un', 'una', 'uno',
  'ud', 'uds', 'und', 'unid', 'unidad', 'unidades', 'mts', 'tipo', 'marca', 'modelo', 'art', 'cod', 'codigo',
])
const MAX_KEYWORD_QUERIES = 4
const RESULTS_PER_QUERY = 25
const MAX_CANDIDATES = 5

/** Minúsculas y sin tildes, para COMPARAR (no para mandar al buscador del core). */
const fold = (s: string | undefined | null) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const isKeyword = (token: string) => !STOPWORDS.has(fold(token)) && (token.length >= 3 || (/\d/.test(token) && token.length >= 2))

/** Palabras clave de un texto, tal como están escritas (el buscador del core distingue tildes). */
function keywords(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || !isKeyword(raw) || seen.has(fold(raw))) continue
    seen.add(fold(raw))
    out.push(raw)
  }
  return out
}

/** Las más distintivas primero: las que llevan números (medidas, amperes, códigos), después las más largas. */
function queryKeywords(text: string): string[] {
  return keywords(text)
    .sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)) || b.length - a.length)
    .slice(0, MAX_KEYWORD_QUERIES)
}

type CatalogKind = 'material' | 'item_subcontratado' | 'item_con_composicion'

/**
 * Material o ítem se decide por `nature` (itemNatureCategory.ts en el core):
 * `nature` ausente es un documento viejo sin backfill y el core lo trata como
 * material. Un ítem solo se puede comprar en una factura si está 100%
 * subcontratado (`subcontractMode: 'full'`): el mismo criterio que `forPurchase`.
 */
function kindOf(item: CatalogItem): CatalogKind {
  if (item.nature !== 'item') return 'material'
  return item.subcontractMode === 'full' ? 'item_subcontratado' : 'item_con_composicion'
}

const KIND_LABEL: Record<CatalogKind, string> = {
  material: 'Material',
  item_subcontratado: 'Ítem 100% subcontratado',
  item_con_composicion: 'Ítem con composición (partida propia): no se puede comprar en una factura',
}

const CreateContactSchema = z.object({
  name: z.string().min(1).describe('Nombre completo o razón social, tal como figura en el documento'),
  contactCategory: z.enum(['supplier', 'client']).describe('"supplier" (proveedor) o "client" (cliente)'),
  taxId: z.string().optional().describe('CIF/NIF/CUIT'),
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional().describe('Dirección en una línea'),
})

const CreateSupplierInvoiceSchema = z.object({
  filePath: z.string().describe('Ruta local del PDF de la factura, exactamente como vino en [Archivo adjunto: ...]'),
  extractedData: ExtractedInvoiceSchema.describe('Datos que leíste del PDF, sin corregir. Las correcciones del usuario van en overrides'),
  supplierId: objectId('supplierId').describe('ID del contacto proveedor (search_contacts o create_contact_from_document)'),
  // Opcional: una factura de gasto general (software, IT, oficina) va sin proyecto
  // y no suma al coste de ninguna obra. El core lo acepta (resolveInvoiceProjectId);
  // con obligatorio, el agente metia esas facturas en una obra cualquiera.
  projectId: objectId('projectId').optional().describe('ID del proyecto al que se imputa la factura. Omitir si es un gasto general sin obra'),
  constructionSiteId: objectId('constructionSiteId').optional().describe('ID de la obra. Omitir si es un gasto general sin obra'),
  constructionOrderId: objectId('constructionOrderId').optional().describe('ID de la orden de obra, si el usuario la indicó'),
  itemResolutions: z.array(z.object({
    description: z.string().describe('Descripción de la línea, igual que en extractedData.items'),
    itemId: objectId('itemId').optional().describe('Ítem existente que el usuario eligió reutilizar (de check_invoice_items_catalog)'),
    nature: z.enum(['material', 'item']).optional().describe('Si no hay itemId: "material" o "item" (ítem subcontratado 100%), según lo que eligió el usuario'),
  })).describe('Una entrada por cada línea, con lo que decidió el usuario. No lo decidas vos'),
  overrides: z.object({
    invoiceNumber: z.string().optional(),
    issueDate: z.string().optional(),
    dueDate: z.string().optional(),
  }).optional().describe('SOLO los datos de cabecera que el usuario corrigió explícitamente'),
})

const CreateClientInvoiceSchema = z.object({
  extractedData: ExtractedInvoiceSchema.describe('Datos que leíste del PDF, con las correcciones que pidió el usuario ya aplicadas'),
  clientId: objectId('clientId').describe('ID del contacto cliente (search_contacts o create_contact_from_document)'),
  projectId: objectId('projectId').describe('ID del proyecto. Obligatorio para facturas de venta'),
  paymentMethod: z.enum(['transfer', 'check', 'cash', 'other']).describe('Método de pago: transferencia, cheque, efectivo u otro. Preguntárselo al usuario'),
  paymentMethodNote: z.string().optional().describe('Obligatorio si paymentMethod es "other"'),
})

const CreateExpenseSchema = z.object({
  filePath: z.string().describe('Ruta local del PDF del ticket o factura, exactamente como vino en [Archivo adjunto: ...]'),
  amount: z.number().positive().describe('Importe total del gasto'),
  date: z.string().optional().describe('Fecha ISO YYYY-MM-DD. Si el documento no la tiene, hoy'),
  description: z.string().min(1).describe('Descripción del gasto'),
  category: z.enum(EXPENSE_CATEGORIES).optional().describe('Categoría del gasto'),
  projectId: objectId('projectId').describe('ID del proyecto'),
  constructionSiteId: objectId('constructionSiteId').describe('ID de la obra'),
})

interface CatalogItem {
  _id: string
  name: string
  code?: string
  description?: string
  unit?: string
  nature?: string
  subcontractMode?: string
  suppliers?: Array<{ providerCode?: string }>
}

interface ContactDoc {
  _id: string
  name: string
  type?: string
  taxId?: string
  email?: string
  phone?: string
}

export function createDocumentIntakeTools(httpClient: HttpClient) {
  /** Ítems que se pueden comprar en una factura: materiales + subcontratados 100% (`forPurchase`, itemsController). */
  const searchPurchasableItems = (term: string, limit: number) =>
    httpClient.get<CatalogItem[]>(`/items?search=${encodeURIComponent(term)}&forPurchase=true&limit=${limit}`)

  /** Todo el catálogo que matchea `term` (materiales e ítems): el tipo se decide después con `nature`. */
  const searchCatalog = async (term: string): Promise<CatalogItem[]> => {
    const items = await httpClient.get<CatalogItem[]>(`/items?search=${encodeURIComponent(term)}&limit=${RESULTS_PER_QUERY}`)
    return Array.isArray(items) ? items : []
  }

  /** Candidatos del catálogo para UNA línea de factura, ordenados del más probable al menos. */
  const findCandidates = async (description: string, userTerms: string[]) => {
    const userQueries = userTerms.map((t) => t.trim()).filter(Boolean)
    const fullPhrase = description.trim()
    const lineKeywords = keywords(description)
    const queries = [...new Set([...userQueries, fullPhrase, ...queryKeywords(description)].filter(Boolean))]

    const results = await Promise.all(queries.map(async (q) => ({ q, items: await searchCatalog(q) })))

    const byId = new Map<string, { item: CatalogItem; fromUser: boolean; fullPhrase: boolean }>()
    for (const { q, items } of results) {
      for (const item of items) {
        const id = String(item._id)
        const entry = byId.get(id) ?? { item, fromUser: false, fullPhrase: false }
        if (userQueries.includes(q)) entry.fromUser = true
        if (q === fullPhrase) entry.fullPhrase = true
        byId.set(id, entry)
      }
    }

    // Se compara contra los mismos campos en los que busca el core: nombre,
    // código, descripción y código de proveedor. Lo que coincide en el nombre o
    // el código pesa más al ordenar: la descripción suele ser texto libre.
    const scored = [...byId.values()].map(({ item, fromUser, fullPhrase: phraseHit }) => {
      const nameAndCode = fold(`${item.name} ${item.code ?? ''}`)
      const otherFields = fold(`${item.description ?? ''} ${(item.suppliers ?? []).map((s) => s.providerCode ?? '').join(' ')}`)
      const matchedTerms = lineKeywords.filter((k) => nameAndCode.includes(fold(k)) || otherFields.includes(fold(k)))
      const nameMatches = lineKeywords.filter((k) => nameAndCode.includes(fold(k))).length
      return { item, fromUser, phraseHit, matchedTerms, nameMatches }
    })

    // Lo que el usuario nombró entra siempre. Lo demás, si comparte al menos dos
    // palabras clave con la línea (o una, cuando la línea casi no tiene).
    const minMatches = lineKeywords.length <= 2 ? 1 : 2
    const kept = scored.filter((c) => c.fromUser || c.phraseHit || c.matchedTerms.length >= minMatches)

    kept.sort((a, b) =>
      Number(b.fromUser) - Number(a.fromUser) ||
      Number(b.phraseHit) - Number(a.phraseHit) ||
      b.nameMatches - a.nameMatches ||
      b.matchedTerms.length - a.matchedTerms.length ||
      Number(kindOf(a.item) !== 'item_con_composicion') - Number(kindOf(b.item) !== 'item_con_composicion') ||
      a.item.name.length - b.item.name.length,
    )

    const candidates = kept.slice(0, MAX_CANDIDATES).map(({ item, fromUser, matchedTerms }) => {
      const kind = kindOf(item)
      return {
        itemId: String(item._id),
        name: item.name,
        code: item.code,
        unit: item.unit,
        nature: item.nature === 'item' ? 'item' : 'material',
        tipo: KIND_LABEL[kind],
        purchasable: kind !== 'item_con_composicion',
        ...(fromUser ? { encontradoCon: 'lo que indicó el usuario' } : {}),
        matchedTerms,
      }
    })

    return {
      description,
      hasCandidates: candidates.some((c) => c.purchasable),
      candidates,
      searched: queries,
    }
  }

  // ── check_invoice_items_catalog ───────────────────────────────────────────
  const checkCatalogTool = tool(
    'check_invoice_items_catalog',
    'Busca en el catálogo de la empresa, POR NOMBRE, candidatos para cada línea de una factura de proveedor que leíste de un PDF. NO crea ni modifica nada. ' +
      'Busca la descripción completa y además cada palabra clave (medidas, marca, palabras largas) en nombre, código, descripción y código de proveedor, ' +
      'y ordena por cuántas coinciden (las del nombre y el código pesan más). ' +
      'Cada candidato dice si es material o ítem (campo nature) y si se puede comprar (purchasable). ' +
      'Si el usuario te dio el nombre o el código de un artículo para una línea, pasalo en searchTerms: se busca tal cual y va primero. ' +
      'Llamala SIEMPRE después de leer la factura y ANTES de mostrarle el resumen al usuario: con el resultado le preguntás, línea por línea, ' +
      'si reutiliza un candidato existente o si se crea nuevo como material o como ítem subcontratado.',
    CheckCatalogSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const { lines } = CheckCatalogSchema.parse(args)
        // Una línea por vez (sus búsquedas van en paralelo): una factura larga no
        // dispara de golpe decenas de requests contra el core.
        const resolved = []
        for (const { description, searchTerms } of lines) {
          resolved.push(description.trim()
            ? await findCandidates(description, searchTerms ?? [])
            : { description, hasCandidates: false, candidates: [], searched: [] })
        }
        logger.info(`check_invoice_items_catalog OK: ${lines.length} línea(s), ${resolved.filter((r) => r.hasCandidates).length} con candidatos`)
        return textResult({ anyCandidates: resolved.some((r) => r.hasCandidates), resolved })
      } catch (err) {
        const message = describeError(err)
        logger.error(`check_invoice_items_catalog FAILED: ${message}`)
        return errorResult(`No se pudo revisar el catálogo: ${message}. Podés seguir: preguntá material o subcontratado para cada línea, sin ofrecer "existente".`)
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false } },
  )

  // ── create_contact_from_document ──────────────────────────────────────────
  const createContactTool = tool(
    'create_contact_from_document',
    'Crea el proveedor o el cliente de una factura. Si ya existe un contacto con el mismo nombre, devuelve el existente sin duplicarlo (created:false). ' +
      'Usala solo después de confirmar con el usuario que el contacto no está en search_contacts.',
    CreateContactSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const { name, contactCategory, taxId, email, phone, address } = CreateContactSchema.parse(args)
        const cleanName = name.trim()

        const matches = await httpClient.get<ContactDoc[]>(`/contacts?q=${encodeURIComponent(cleanName)}`)
        const existing = (Array.isArray(matches) ? matches : []).find((c) => normalizeText(c.name) === normalizeText(cleanName))
        if (existing) {
          logger.info(`create_contact_from_document: contacto existente ${existing._id} (${existing.name})`)
          return textResult({
            created: false,
            contact: { _id: existing._id, name: existing.name, taxId: existing.taxId, email: existing.email, phone: existing.phone },
            message: `Ya existe el contacto "${existing.name}". Se usa el existente.`,
          })
        }

        const contact = await httpClient.post<ContactDoc>('/contacts', {
          name: cleanName,
          type: 'company',
          isActive: true,
          ...(taxId ? { taxId } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(address ? { mailingAddress: { street: address } } : {}),
          tags: [contactCategory],
          description: `Creado desde CERP IA Desktop (${contactCategory === 'supplier' ? 'proveedor' : 'cliente'})`,
        })
        logger.info(`create_contact_from_document OK: ${contact._id} (${contact.name})`)
        return textResult({
          created: true,
          contact: { _id: contact._id, name: contact.name, taxId: contact.taxId, email: contact.email, phone: contact.phone },
          message: `Contacto "${contact.name}" creado.`,
        })
      } catch (err) {
        const message = describeError(err)
        logger.error(`create_contact_from_document FAILED: ${message}`)
        return errorResult(`No se pudo crear el contacto: ${message}`)
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  // ── create_supplier_invoice_from_document ─────────────────────────────────
  const createSupplierInvoiceTool = tool(
    'create_supplier_invoice_from_document',
    'Crea una factura de proveedor en BORRADOR a partir de un PDF, con el PDF adjunto. Cada línea queda vinculada a un ítem del catálogo: ' +
      'el que el usuario eligió reutilizar, uno con el mismo nombre si existe, o uno nuevo (material o subcontratado según itemResolutions). ' +
      'Si esa factura del mismo proveedor ya estaba cargada, no crea otra (duplicate:true). ' +
      'Sin projectId ni constructionSiteId queda como gasto general, sin imputar a ninguna obra (software, IT, oficina). ' +
      'Solo llamar tras la confirmación explícita del usuario.',
    CreateSupplierInvoiceSchema as any,
    async (args: Record<string, unknown>) => {
      let parsed: z.infer<typeof CreateSupplierInvoiceSchema> | undefined
      try {
        parsed = CreateSupplierInvoiceSchema.parse(args)
        const { filePath, supplierId, projectId, constructionSiteId, constructionOrderId, itemResolutions, overrides } = parsed
        const data = { ...parsed.extractedData, ...(overrides ?? {}) }

        const pdfProblem = checkPdf(filePath, MAX_SUPPLIER_INVOICE_PDF_BYTES)
        if (pdfProblem) return errorResult(pdfProblem)

        // Importes negativos = nota de crédito. `POST /supplier-invoices` no recibe
        // el tipo de documento: la cargaria como factura y SUMARIA costo a la obra
        // en vez de restarlo. No se carga aunque el usuario insista.
        const hasNegative =
          (typeof data.totalAmount === 'number' && data.totalAmount < 0) ||
          data.items.some((line) => (line.unitCost ?? 0) < 0 || (line.quantity ?? 1) < 0)
        if (hasNegative) {
          return errorResult(
            'El documento tiene importes negativos: es una nota de crédito, no una factura. CERP IA no puede cargar notas de crédito de proveedor, ' +
              'y cargarla como factura sumaría ese importe como costo en vez de restarlo. No la cargues: explicale esto al usuario.',
          )
        }

        // 1) Idempotencia, igual que WhatsApp: proveedor + número de factura. Sin
        //    número no hay forma confiable de deduplicar y se sigue de largo.
        if (data.invoiceNumber) {
          const list = await httpClient.get<{ data?: { invoices?: Array<{ _id: string; serialNumber?: string; supplierInvoiceNumber?: string; totalAmount?: number; invoiceStatus?: string }> } }>(
            `/supplier-invoices?supplierId=${supplierId}&limit=200`,
          )
          const wanted = normalizeText(data.invoiceNumber)
          const existing = list?.data?.invoices?.find((inv) => normalizeText(inv.supplierInvoiceNumber) === wanted)
          if (existing) {
            logger.info(`create_supplier_invoice_from_document: duplicada, ya existe ${existing.serialNumber}`)
            return textResult({
              success: true,
              duplicate: true,
              _id: existing._id,
              serialNumber: existing.serialNumber,
              totalAmount: existing.totalAmount,
              status: existing.invoiceStatus,
              link: `${APP_BASE_URL}/supplier-invoices/${existing._id}`,
              summary: `Esta factura ya estaba cargada como ${existing.serialNumber}. No se creó una copia.`,
            })
          }
        }

        // 2) Resolver cada línea a un ítem del catálogo, con caché por nombre para
        //    no crear dos veces el mismo producto repetido en la factura.
        const findResolution = (description: string) => {
          const norm = normalizeText(description)
          if (!norm) return undefined
          return itemResolutions.find((r) => normalizeText(r.description) === norm)
            ?? itemResolutions.find((r) => {
              const rNorm = normalizeText(r.description)
              return rNorm && (norm.includes(rNorm) || rNorm.includes(norm))
            })
        }

        const itemIdCache = new Map<string, string>()
        const createdItems: string[] = []
        const failedLines: Array<{ description: string; error: string }> = []
        const invoiceItems: Array<{ itemId: string; quantity: number; unit: string; unitCost: number; totalCost: number; taxRate: number }> = []

        for (const line of data.items) {
          const rawName = line.description.trim()
          const name = rawName || 'Producto sin descripción'
          const quantity = line.quantity || 1
          const unitCost = line.unitCost ?? 0
          const unit = line.unit || 'unidad'
          const cacheKey = normalizeText(name)
          const resolution = findResolution(name)

          let itemId = itemIdCache.get(cacheKey)

          // a) Ítem que el usuario eligió reutilizar. GET /items/:id está filtrado
          //    por empresa: un id ajeno o borrado da 404 y se sigue con b/c.
          if (!itemId && resolution?.itemId) {
            try {
              const confirmed = await httpClient.get<CatalogItem>(`/items/${resolution.itemId}`)
              if (confirmed?._id) itemId = String(confirmed._id)
            } catch (err) {
              logger.warn(`itemId ${resolution.itemId} para "${name}" no es válido: ${describeError(err)}`)
            }
          }

          // b) Match exacto por nombre (red de contención si no pasó por el chequeo previo).
          if (!itemId) {
            const matches = await searchPurchasableItems(name, 10)
            const exact = (Array.isArray(matches) ? matches : []).find((it) => normalizeText(it.name) === cacheKey)
            if (exact) itemId = String(exact._id)
          }

          // c) Crearlo. Sin decisión del usuario se cae a material, el default más
          //    conservador (no crea un subcontratado con un costo no confirmado).
          if (!itemId) {
            const isSubcontracted = resolution?.nature === 'item'
            const payload = (code: string) => ({
              name,
              code,
              unit,
              description: rawName || undefined,
              defaultCost: unitCost,
              ...(isSubcontracted
                ? { nature: 'item', subcontractMode: 'full', costoUnitario: unitCost }
                : { nature: 'material' }),
            })
            try {
              let created: CatalogItem
              try {
                created = await httpClient.post<CatalogItem>('/items', payload(generateItemCode(name)))
              } catch (err) {
                if (errorCode(err) !== 'CODE_ALREADY_EXISTS') throw err
                created = await httpClient.post<CatalogItem>('/items', payload(generateItemCode(name)))
              }
              itemId = String(created._id)
              createdItems.push(`${name} (${isSubcontracted ? 'subcontratado' : 'material'})`)
            } catch (err) {
              failedLines.push({ description: name, error: describeError(err) })
              continue
            }
          }

          itemIdCache.set(cacheKey, itemId)
          invoiceItems.push({
            itemId,
            quantity,
            unit,
            unitCost,
            totalCost: round2(unitCost * quantity),
            taxRate: line.taxRate ?? 0,
          })
        }

        // Vía REST cada línea necesita itemId: si alguna no se pudo resolver, la
        // factura no se crea (ver cabecera del archivo).
        if (failedLines.length > 0) {
          return errorResult(
            `No se creó la factura: ${failedLines.length} línea(s) no se pudieron dar de alta en el catálogo. ` +
              failedLines.map((f) => `"${f.description}": ${f.error}`).join('; ') +
              (createdItems.length > 0 ? `. Ya quedaron creados en el catálogo: ${createdItems.join(', ')}.` : '') +
              ` Mostrale al usuario todos los datos extraídos para que la cargue a mano (guía: ${DOCS_SUPPLIER_INVOICE_MANUAL_URL}).`,
          )
        }

        // 3) Fechas: sin vencimiento (o con uno anterior a la emisión, que el core
        //    rechaza) se usa emisión + 30 días, igual que WhatsApp.
        const issueDate = data.issueDate ? new Date(data.issueDate) : new Date()
        if (Number.isNaN(issueDate.getTime())) return errorResult(`Fecha de emisión inválida: ${data.issueDate}`)
        let dueDate = data.dueDate ? new Date(data.dueDate) : null
        const dueDateEstimated = !dueDate || Number.isNaN(dueDate.getTime()) || dueDate < issueDate
        if (dueDateEstimated) dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000)

        // 4) Crear la factura. Subtotal, impuestos y total los calcula el pre-save
        //    del modelo a partir de las líneas.
        const created = await httpClient.post<{ data: { _id: string; serialNumber: string; totalAmount: number; invoiceStatus: string } }>(
          '/supplier-invoices',
          {
            supplierId,
            ...(projectId ? { projectId } : {}),
            ...(constructionSiteId ? { constructionSiteId } : {}),
            ...(constructionOrderId ? { constructionOrderId } : {}),
            supplierInvoiceNumber: data.invoiceNumber || undefined,
            issueDate: issueDate.toISOString(),
            dueDate: dueDate!.toISOString(),
            items: invoiceItems,
          },
        )
        const invoice = created.data

        // 5) Adjuntar el PDF. Si falla, la factura ya existe: se avisa y se sigue.
        let attachFailed = false
        try {
          await httpClient.uploadFile(`/supplier-invoices/${invoice._id}/pdf`, pdfFormData(filePath, 'file'))
        } catch (err) {
          attachFailed = true
          logger.error(`create_supplier_invoice_from_document: no se pudo adjuntar el PDF a ${invoice._id}: ${describeError(err)}`)
        }

        const warnings: string[] = []
        if (dueDateEstimated) warnings.push('Vencimiento estimado en 30 días desde la emisión: revisalo en CERP.')
        if (attachFailed) warnings.push('No se pudo adjuntar el PDF: subilo a mano desde la ficha de la factura.')
        if (typeof data.totalAmount === 'number' && Math.abs(round2(invoice.totalAmount) - round2(data.totalAmount)) > 0.01) {
          warnings.push(`El total calculado por CERP (${invoice.totalAmount.toFixed(2)}) no coincide con el del documento (${data.totalAmount.toFixed(2)}): revisá precios, cantidades e IVA de las líneas.`)
        }
        if (createdItems.length > 0) warnings.push(`Ítems nuevos en el catálogo: ${createdItems.join(', ')}.`)

        logger.info(`create_supplier_invoice_from_document OK: ${invoice.serialNumber} (${invoice.totalAmount})`)
        return textResult({
          success: true,
          _id: invoice._id,
          serialNumber: invoice.serialNumber,
          totalAmount: invoice.totalAmount,
          status: invoice.invoiceStatus,
          link: `${APP_BASE_URL}/supplier-invoices/${invoice._id}`,
          warnings,
          summary: `Factura de proveedor creada en borrador: ${invoice.serialNumber} por ${invoice.totalAmount.toFixed(2)}` +
            (projectId || constructionSiteId ? '.' : ', como gasto general (sin obra).'),
        })
      } catch (err) {
        const message = describeError(err)
        logger.error(`create_supplier_invoice_from_document FAILED: ${message}`)
        return errorResult(
          `No se pudo crear la factura de proveedor: ${message}. Mostrale al usuario todos los datos extraídos para que la cargue a mano (guía: ${DOCS_SUPPLIER_INVOICE_MANUAL_URL}). No inventes causas técnicas.`,
        )
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  // ── create_client_invoice_from_document ───────────────────────────────────
  const createClientInvoiceTool = tool(
    'create_client_invoice_from_document',
    'Crea una factura de cliente (venta) en BORRADOR a partir de los datos que leíste de un PDF. El PDF NO queda adjunto: avisale al usuario. ' +
      'El número de la factura original queda en las notas. Solo llamar tras la confirmación explícita del usuario.',
    CreateClientInvoiceSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const { extractedData, clientId, projectId, paymentMethod, paymentMethodNote } = CreateClientInvoiceSchema.parse(args)
        if (paymentMethod === 'other' && !paymentMethodNote?.trim()) {
          return errorResult('Con paymentMethod "other" hace falta paymentMethodNote: preguntale al usuario cuál es el método de pago.')
        }

        const lines = extractedData.items.map((line) => ({
          sourceType: 'custom',
          description: line.description.trim() || 'Línea de factura',
          quantity: line.quantity || 1,
          unit: line.unit || 'Unidad',
          unitPrice: line.unitCost ?? 0,
          taxRate: line.taxRate ?? 21,
        }))

        const created = await httpClient.post<{ data: { _id: string; serialNumber?: string; total?: number; status?: string } }>(
          '/invoices/direct',
          {
            clientId,
            projectId,
            date: extractedData.issueDate || new Date().toISOString().slice(0, 10),
            paymentMethod,
            ...(paymentMethodNote ? { paymentMethodNote } : {}),
            lines,
            notes: extractedData.invoiceNumber ? `Referencia factura original: ${extractedData.invoiceNumber}` : undefined,
          },
        )
        const invoice = created.data
        const total = typeof invoice.total === 'number' ? invoice.total : undefined

        logger.info(`create_client_invoice_from_document OK: ${invoice.serialNumber} (${total})`)
        return textResult({
          success: true,
          _id: invoice._id,
          serialNumber: invoice.serialNumber,
          total,
          status: invoice.status,
          summary: `Factura de cliente creada en borrador: ${invoice.serialNumber ?? invoice._id}${total !== undefined ? ` por ${total.toFixed(2)}` : ''}. El PDF original no queda adjunto.`,
        })
      } catch (err) {
        const message = describeError(err)
        logger.error(`create_client_invoice_from_document FAILED: ${message}`)
        return errorResult(
          `No se pudo crear la factura de cliente: ${message}. Mostrale al usuario los datos extraídos para que la cargue a mano (guía: ${DOCS_CLIENT_INVOICE_MANUAL_URL}). No inventes causas técnicas.`,
        )
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  // ── create_expense_from_document ──────────────────────────────────────────
  const createExpenseTool = tool(
    'create_expense_from_document',
    'Registra un gasto (queda pendiente de aprobación) a partir de un ticket o factura en PDF, con el PDF adjunto. ' +
      'Solo llamar tras la confirmación explícita del usuario.',
    CreateExpenseSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const { filePath, amount, date, description, category, projectId, constructionSiteId } = CreateExpenseSchema.parse(args)

        // Se valida ANTES de crear el gasto para no dejar un gasto sin comprobante
        // por un archivo que el endpoint iba a rechazar igual.
        const pdfProblem = checkPdf(filePath, MAX_EXPENSE_ATTACHMENT_BYTES)
        if (pdfProblem) return errorResult(pdfProblem)

        const expense = await httpClient.post<{ _id: string; sequenceNumber?: string; amount: number; status?: string }>('/expenses', {
          projectId,
          constructionSiteId,
          amount,
          date: date || new Date().toISOString().slice(0, 10),
          description,
          ...(category ? { category } : {}),
        })

        let attachFailed = false
        try {
          await httpClient.uploadFile(`/expenses/${expense._id}/attachment`, pdfFormData(filePath, 'attachment'))
        } catch (err) {
          attachFailed = true
          logger.error(`create_expense_from_document: no se pudo adjuntar el PDF a ${expense._id}: ${describeError(err)}`)
        }

        logger.info(`create_expense_from_document OK: ${expense.sequenceNumber} (${expense.amount})`)
        return textResult({
          success: true,
          _id: expense._id,
          sequenceNumber: expense.sequenceNumber,
          amount: expense.amount,
          status: expense.status,
          warnings: attachFailed ? ['No se pudo adjuntar el PDF: subilo a mano desde el gasto en CERP.'] : [],
          summary: `Gasto registrado como pendiente: ${expense.sequenceNumber ?? expense._id} por ${expense.amount.toFixed(2)}.`,
        })
      } catch (err) {
        const message = describeError(err)
        logger.error(`create_expense_from_document FAILED: ${message}`)
        return errorResult(
          `No se pudo registrar el gasto: ${message}. Mostrale al usuario los datos extraídos para que lo cargue a mano (guía: ${DOCS_EXPENSE_MANUAL_URL}). No inventes causas técnicas.`,
        )
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  return [checkCatalogTool, createContactTool, createSupplierInvoiceTool, createClientInvoiceTool, createExpenseTool]
}
