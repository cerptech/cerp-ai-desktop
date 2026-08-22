import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { HttpClient, HttpError } from '../utils/httpClient'
import { logger } from '../utils/logger'

/**
 * Tools del BANCO DE ÍTEMS para el cliente desktop.
 *
 * # Por qué viven acá y no en toolDefinitions.ts
 *
 * El resto de las tools son proxies REST declarativos (endpoint + schema) y con
 * eso alcanza. Estas tres no:
 *
 * 1. **La moneda no la puede elegir el modelo.** Los tres endpoints del banco
 *    exigen `currency` y filtran por ella (no convierten — ADR 004). Si el
 *    modelo la adivina mal, el banco responde 0 resultados y el agente le dice
 *    al usuario "no encontré esa partida" cuando en realidad preguntó en la
 *    moneda equivocada. Acá se resuelve del presupuesto (que es lo que manda al
 *    importar) o de los ajustes de la empresa, nunca del modelo.
 * 2. **El volumen de la respuesta se paga en créditos.** El listado del banco
 *    devuelve taxonomías, variantes y estado de verificación por ítem; el
 *    import devuelve hasta 500 `results` con su desglose de costes. Se compacta
 *    a lo que el modelo necesita para decidir.
 * 3. **Los fallos son parciales.** `import-from-bank` responde 201 aunque
 *    `summary.failed > 0`. Sin separar importados de fallidos, el agente lee
 *    "201" como "cargué todo" y le miente al usuario.
 *
 * # Contrato con el core (no hay backend nuevo)
 *
 * - `GET  /api/item-bank/items`                       (permiso budgets:view)
 * - `GET  /api/item-bank/items/:itemId`               (permiso budgets:view)
 * - `POST /api/budgets/:budgetId/items/import-from-bank` (permiso budgets:edit)
 *
 * Las tres rutas van detrás de `auth` + `checkPermission`, y el `companyId`
 * sale SIEMPRE de la sesión del JWT (ADR 007): un usuario sin el módulo de
 * presupuestos recibe 403 acá y no hay forma de forzarlo desde el chat.
 */

/** Tope por búsqueda: el modelo tiene que elegir, no leerse el banco entero. */
const MAX_SEARCH_RESULTS = 25
const DEFAULT_SEARCH_RESULTS = 10

/**
 * Tope por llamada de import. El backend acepta 500, pero se corta antes a
 * propósito: los capítulos se reutilizan entre llamadas (`reuseByName`, default
 * true en BudgetChapterPlannerService), así que partir un presupuesto grande en
 * varias llamadas es seguro y deja checkpoints intermedios en vez de un único
 * POST de varios minutos que, si se corta, no se sabe por dónde quedó.
 */
const MAX_IMPORT_ITEMS = 200

const SearchItemBankSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe(
      'Que buscar, en español y con terminos del oficio: "muro de ladrillo hueco", "excavacion zanja", "solado porcelanico". ' +
        'Busca por el CONCEPTO, no por la oracion entera del pliego. ' +
        'Los acentos y las palabras a medias no son problema: si la busqueda exacta no encuentra nada, el banco reintenta por prefijo sin tildes.',
    ),
  kind: z
    .enum(['work_item', 'material', 'labor', 'machinery'])
    .optional()
    .describe(
      'Tipo de item. Por defecto "work_item" (partidas de obra, que es lo que va en un presupuesto). ' +
        'Usar "material"/"labor"/"machinery" solo si hacen falta componentes sueltos.',
    ),
  limit: z
    .number()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe(`Cuantos resultados devolver (1-${MAX_SEARCH_RESULTS}, por defecto ${DEFAULT_SEARCH_RESULTS}).`),
  budgetId: z
    .string()
    .optional()
    .describe(
      'ID del presupuesto donde se van a importar estas partidas. PASALO SIEMPRE que ya exista el presupuesto: ' +
        'el banco filtra por moneda y la que vale es la del presupuesto, no la de la conversacion.',
    ),
})

const GetBankItemDetailsSchema = z.object({
  bankItemId: z.string().describe('itemId del banco (campo `bankItemId` devuelto por search_item_bank).'),
  budgetId: z.string().optional().describe('ID del presupuesto destino, para resolver la moneda. Pasalo si ya existe.'),
})

const ImportBankItemsSchema = z.object({
  budgetId: z.string().describe('ID del presupuesto destino (Budget document, no el projectId). Debe estar en estado "draft".'),
  items: z
    .array(
      z.object({
        bankItemId: z.string().describe('itemId del banco, tal cual lo devolvio search_item_bank. NUNCA inventarlo.'),
        quantity: z.number().positive().describe('Cantidad medida de esta partida. Sale de la medicion del usuario, no del banco.'),
        name: z
          .string()
          .optional()
          .describe('Nombre a mostrar en el presupuesto. Si se omite se usa el resumen del banco (recomendado: dejarlo).'),
        overheadOverride: z.number().optional().describe('Override del % de gastos generales para esta partida.'),
        parentItemId: z
          .string()
          .optional()
          .describe('ID de un capitulo YA existente del presupuesto donde colgar esta partida puntual.'),
      }),
    )
    .min(1)
    .max(MAX_IMPORT_ITEMS)
    .describe(`Partidas a importar (max ${MAX_IMPORT_ITEMS} por llamada; si hay mas, partir en varias llamadas).`),
  grouping: z
    .enum(['taxonomy', 'taxonomy+section', 'target', 'none'])
    .optional()
    .describe(
      'Como se agrupan en capitulos. "taxonomy" (default) recrea en el presupuesto los capitulos del banco. ' +
        '"target" cuelga todo de un capitulo existente (requiere targetParentItemId). "none" manda todo a la raiz.',
    ),
  targetParentItemId: z.string().optional().describe('ID del capitulo destino. OBLIGATORIO si grouping es "target".'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'true = previsualizacion con garantia de CERO escrituras: devuelve los mismos capitulos, precios y avisos que la carga real. ' +
        'Correr SIEMPRE con dryRun:true primero, mostrarle la tabla al usuario, y recien despues repetir la llamada con dryRun:false.',
    ),
})

interface BankListResponse {
  success?: boolean
  data?: {
    items?: Array<Record<string, any>>
    pagination?: { total?: number }
    currency?: string
  }
}

interface BankDetailResponse {
  success?: boolean
  data?: Record<string, any>
}

interface ImportResponse {
  summary?: Record<string, number>
  chapters?: Array<Record<string, any>>
  chaptersWithoutDates?: string[]
  results?: Array<Record<string, any>>
  budgetTotals?: unknown
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
}

/** Nombre del capítulo del banco (taxonomía de orden de ejecución) al que pertenece la partida. */
function chapterLabel(taxonomy: unknown): string | null {
  if (!Array.isArray(taxonomy) || taxonomy.length === 0) return null
  const preferred = taxonomy.find((t: any) => t?.taxonomyId === 'orden-ejecucion') ?? taxonomy[0]
  const label = (preferred as any)?.nodeLabel
  return typeof label === 'string' && label ? label : null
}

export function createItemBankTools(httpClient: HttpClient) {
  // Cachés por instancia (una por conversación): la moneda de una empresa o de
  // un presupuesto no cambia en medio de un armado, y sin esto cada búsqueda
  // del agente pagaría un GET extra.
  let companyCurrency: string | null = null
  const budgetCurrency = new Map<string, string>()

  /**
   * Moneda con la que se consulta el banco. Prioridad: la del presupuesto
   * destino (es la que usa `import-from-bank` para mapear el precio, así que
   * buscar en otra garantiza que lo encontrado no se pueda importar) y, sin
   * presupuesto todavía, la de la empresa.
   */
  async function resolveCurrency(budgetId?: string): Promise<string> {
    if (budgetId) {
      const cached = budgetCurrency.get(budgetId)
      if (cached) return cached
      // Se cachea el resultado FINAL bajo el budgetId, incluido el fallback: un
      // budgetId equivocado o un presupuesto sin moneda no debe costar un GET
      // fallido en cada busqueda del agente.
      const resolved = await resolveBudgetCurrency(budgetId)
      budgetCurrency.set(budgetId, resolved)
      return resolved
    }
    return resolveCompanyCurrency()
  }

  async function resolveBudgetCurrency(budgetId: string): Promise<string> {
    try {
      const res = (await httpClient.get(`/budgets/${budgetId}`)) as { data?: { currency?: string } } | null
      const currency = res?.data?.currency
      if (typeof currency === 'string' && currency.trim()) return currency.trim()
    } catch (err) {
      // Un budgetId equivocado no debe romper la búsqueda: se degrada a la
      // moneda de la empresa, que es la que ese presupuesto habría heredado.
      logger.warn(`item-bank: no se pudo leer la moneda del presupuesto ${budgetId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return resolveCompanyCurrency()
  }

  async function resolveCompanyCurrency(): Promise<string> {
    if (companyCurrency) return companyCurrency
    const res = (await httpClient.get('/companies/settings/currency')) as { currency?: string } | null
    const currency = typeof res?.currency === 'string' && res.currency.trim() ? res.currency.trim() : 'EUR'
    companyCurrency = currency
    return currency
  }

  // ── search_item_bank ──────────────────────────────────────────────────────
  const searchItemBankTool = tool(
    'search_item_bank',
    'Busca partidas y materiales con PRECIO REAL en el banco de items publico de CERP (bases de precios de la construccion: BCCA/BDC Madrid para España, catalogo propio para Argentina). ' +
      'Usar para armar presupuestos cuando la empresa no tiene catalogo propio cargado, o para completar las partidas que le faltan. ' +
      'Devuelve el precio unitario con su fuente y su fecha, en la moneda del presupuesto. ' +
      'IMPORTANTE: consultar SIEMPRE primero search_materials (catalogo propio de la empresa) — si la partida ya esta cargada ahi, ese precio manda. ' +
      'Los precios vienen tal cual de la base: no los redondees, no los ajustes por inflacion y no los conviertas de moneda.',
    SearchItemBankSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = SearchItemBankSchema.parse(args)
        const currency = await resolveCurrency(parsed.budgetId)
        const limit = parsed.limit ?? DEFAULT_SEARCH_RESULTS

        const params = new URLSearchParams({
          currency,
          q: parsed.query.trim(),
          kind: parsed.kind ?? 'work_item',
          limit: String(limit),
        })
        const res = (await httpClient.get(`/item-bank/items?${params.toString()}`)) as BankListResponse
        const rows = res?.data?.items ?? []

        if (rows.length === 0) {
          // Distinguir "tu busqueda no matcheo" de "el banco no tiene NADA en
          // esta moneda" — son dos cosas que el agente tiene que explicar
          // distinto. El banco publicado hoy es integramente EUR (España), asi
          // que toda empresa que presupueste en otra moneda cae en el segundo
          // caso; sin este chequeo el agente manda al usuario a reformular una
          // busqueda que nunca va a devolver nada. Como no se convierte moneda
          // (ADR 004), la salida honesta es decirselo y usar el catalogo propio.
          const probe = (await httpClient.get(
            `/item-bank/items?${new URLSearchParams({ currency, limit: '1' }).toString()}`,
          )) as BankListResponse
          const bankHasCurrency = (probe?.data?.items?.length ?? 0) > 0

          return textResult({
            moneda: currency,
            total: 0,
            items: [],
            sinBancoEnEstaMoneda: !bankHasCurrency,
            nota: bankHasCurrency
              ? `Sin resultados para "${parsed.query}" en ${currency}. Proba con un termino mas general (ej. "muro" en vez de "muro de ladrillo hueco 12cm").`
              : `El banco de items no tiene precios en ${currency}, que es la moneda de este presupuesto. ` +
                'Decíselo al usuario con naturalidad y arma el presupuesto con el catalogo propio (search_materials) o con partidas nuevas cuyos precios te pase el. ' +
                'NO conviertas precios de otra moneda ni estimes valores: un presupuesto con precios inventados es peor que no tener presupuesto.',
          })
        }

        const items = rows.map((item: any) => ({
          bankItemId: item.itemId,
          resumen: item.summary,
          unidad: item.unitCerp || item.unit || null,
          precioUnitario: item.price?.value ?? null,
          moneda: currency,
          fuente: item.price?.source ?? null,
          codigoFuente: item.price?.sourceCode ?? null,
          fechaPrecio: item.price?.date ?? null,
          componentes: item.bomLineCount ?? 0,
          capituloBanco: chapterLabel(item.taxonomy),
        }))

        logger.info(`search_item_bank OK: "${parsed.query}" (${currency}) → ${items.length} resultados`)
        return textResult({
          moneda: currency,
          total: items.length,
          items,
          nota:
            'Precios de bases publicas de la construccion. Usa `bankItemId` y `precioUnitario` TAL CUAL. ' +
            'Para cargarlos al presupuesto usa import_bank_items_to_budget con esos bankItemId — NO los crees a mano con add_budget_items_batch: ' +
            'el import trae ademas el desglose (materiales, mano de obra, maquinaria) y deja el origen trazado en el catalogo de la empresa. ' +
            'Al mostrarle el presupuesto al usuario, cita la fuente de los precios.',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`search_item_bank FAILED: ${message}`)
        return errorResult(
          err instanceof HttpError && err.status === 403
            ? 'Este usuario no tiene permiso sobre el modulo de presupuestos, asi que no puede consultar el banco de items. Decíselo y no reintentes.'
            : message,
        )
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false } },
  )

  // ── get_bank_item_details ─────────────────────────────────────────────────
  const getBankItemDetailsTool = tool(
    'get_bank_item_details',
    'Detalle de UNA partida del banco de items: precio unitario con su fuente y fecha, y el desglose completo (APU) con materiales, mano de obra y maquinaria, cada uno con su cantidad y su coste. ' +
      'Usar cuando el usuario pregunta "que incluye esta partida" o hay que justificar un precio ante el cliente. ' +
      'NO hace falta llamarla antes de importar: import_bank_items_to_budget ya trae el desglose solo.',
    GetBankItemDetailsSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = GetBankItemDetailsSchema.parse(args)
        const currency = await resolveCurrency(parsed.budgetId)

        const res = (await httpClient.get(
          `/item-bank/items/${encodeURIComponent(parsed.bankItemId)}?${new URLSearchParams({ currency }).toString()}`,
        )) as BankDetailResponse
        const d = res?.data
        if (!d) return errorResult(`No se encontro la partida ${parsed.bankItemId} en el banco.`)

        logger.info(`get_bank_item_details OK: ${parsed.bankItemId} (${currency})`)
        return textResult({
          bankItemId: d.itemId,
          resumen: d.summary,
          descripcion: d.text ?? null,
          unidad: d.unitCerp || d.unit || null,
          moneda: currency,
          precioUnitario: d.price?.value ?? null,
          fuente: d.price?.source ?? null,
          codigoFuente: d.price?.sourceCode ?? null,
          fechaPrecio: d.price?.date ?? null,
          edicion: d.price?.edition ?? null,
          capituloBanco: chapterLabel(d.taxonomy),
          desglose: Array.isArray(d.bom)
            ? d.bom.map((line: any) => ({
                concepto: line.summary ?? null,
                rol: line.role ?? null,
                unidad: line.unitCerp || line.unit || null,
                cantidad: line.quantity ?? null,
                precioUnitario: line.unitPrice ?? null,
                importe: line.lineTotal ?? null,
                // `isPercentage` marca las lineas de costes indirectos del banco
                // (medios auxiliares): son un % del resto, no una cantidad fisica.
                esPorcentaje: line.isPercentage === true ? true : undefined,
              }))
            : [],
          totalesDesglose: d.bomTotals ?? null,
          gastosGeneralesSugeridosPct: d.suggestedOverheadPercentage ?? null,
          desvioPrecioVsDesglose: d.priceVsBomDelta ?? null,
          avisos: d.warnings ?? [],
          atribuciones: d.attributions ?? [],
          nota: 'Los importes vienen de la base de precios. Citalos tal cual, con su fuente y su fecha.',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`get_bank_item_details FAILED: ${message}`)
        return errorResult(message)
      }
    },
    { annotations: { readOnlyHint: true, destructiveHint: false } },
  )

  // ── import_bank_items_to_budget ───────────────────────────────────────────
  const importBankItemsTool = tool(
    'import_bank_items_to_budget',
    'Carga partidas del banco de items en un presupuesto de CERP, con su desglose completo (materiales, mano de obra, maquinaria) y creando los capitulos que hagan falta. ' +
      'Es la via CORRECTA para presupuestar con el banco: crea o reutiliza el catalogo de la empresa dejando trazado el origen, asi que reimportar la misma partida no duplica nada. ' +
      'FLUJO OBLIGATORIO: primero dryRun:true (cero escrituras) para mostrarle al usuario la tabla de lo que se va a cargar y pedirle confirmacion, y recien con su SI la misma llamada con dryRun:false. ' +
      'El presupuesto tiene que estar en estado "draft". Responde exito parcial: mira SIEMPRE `fallidos` antes de decirle al usuario que cargaste todo.',
    ImportBankItemsSchema as any,
    async (args: Record<string, unknown>) => {
      try {
        const parsed = ImportBankItemsSchema.parse(args)
        const mode = parsed.grouping ?? 'taxonomy'
        if (mode === 'target' && !parsed.targetParentItemId) {
          return errorResult('grouping "target" requiere targetParentItemId (el ID del capitulo destino).')
        }

        const body = {
          grouping: {
            mode,
            ...(parsed.targetParentItemId ? { targetParentItemId: parsed.targetParentItemId } : {}),
          },
          items: parsed.items.map((i) => ({
            bankItemId: i.bankItemId,
            quantity: i.quantity,
            ...(i.name ? { name: i.name } : {}),
            ...(i.overheadOverride !== undefined ? { overheadOverride: i.overheadOverride } : {}),
            ...(i.parentItemId ? { parentItemId: i.parentItemId } : {}),
          })),
          dryRun: parsed.dryRun === true,
        }

        const res = (await httpClient.post(`/budgets/${parsed.budgetId}/items/import-from-bank`, body)) as ImportResponse

        const results = res?.results ?? []
        const importados = results
          .filter((r: any) => r.status === 'imported')
          .map((r: any) => ({
            bankItemId: r.bankItemId,
            budgetItemId: r.budgetItemId,
            numero: r.hierarchyNumber,
            capitulo: Array.isArray(r.chapterPath) ? r.chapterPath.join(' > ') : null,
            cantidad: r.quantity,
            precioUnitario: r.unitCost,
            avisos: r.warnings?.length ? r.warnings : undefined,
          }))
        const fallidos = results
          .filter((r: any) => r.status === 'failed')
          .map((r: any) => ({ bankItemId: r.bankItemId, error: r.error, detalle: r.message }))

        logger.info(
          `import_bank_items_to_budget OK (dryRun=${body.dryRun}): ${importados.length} importados, ${fallidos.length} fallidos → budget ${parsed.budgetId}`,
        )

        return textResult({
          simulacion: body.dryRun,
          resumen: res?.summary ?? null,
          capitulos: (res?.chapters ?? []).map((c: any) => ({
            nombre: c.name,
            numero: c.hierarchyNumber,
            ruta: Array.isArray(c.path) ? c.path.join(' > ') : null,
            creado: c.created,
            budgetItemId: c.budgetItemId,
          })),
          importados,
          fallidos,
          totalesPresupuesto: body.dryRun ? undefined : (res?.budgetTotals ?? null),
          nota: body.dryRun
            ? 'SIMULACION: no se escribio nada. Mostrale al usuario la tabla de capitulos y partidas con sus precios y pedile confirmacion explicita antes de repetir esta llamada con dryRun:false.'
            : fallidos.length > 0
              ? `Carga PARCIAL: ${importados.length} partidas cargadas y ${fallidos.length} fallidas. Contale al usuario cuales fallaron y por que — no digas que cargaste todo. Despues llama a recalculate_budget.`
              : 'Partidas cargadas. Acordate de update_cost_items (GG/BI/IVA) y recalculate_budget para cerrar el presupuesto.',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`import_bank_items_to_budget FAILED: ${message}`)
        if (err instanceof HttpError && err.status === 409) {
          return errorResult(
            'El presupuesto no esta en estado "draft", asi que no admite importar partidas. ' +
              'Si ya fue enviado o aprobado hay que revertirlo desde la app web antes de seguir. NO reintentes.',
          )
        }
        if (err instanceof HttpError && err.status === 403) {
          return errorResult(
            'Este usuario no tiene permiso de edicion sobre el modulo de presupuestos. Decíselo y no reintentes.',
          )
        }
        return errorResult(message)
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: false } },
  )

  return [searchItemBankTool, getBankItemDetailsTool, importBankItemsTool]
}
