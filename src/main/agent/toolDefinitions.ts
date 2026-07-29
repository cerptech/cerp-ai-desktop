import { z } from 'zod'

/**
 * CERP MCP Tool definitions.
 * Each tool maps to a CERP backend REST API endpoint.
 * Organized by module: READ tools + WRITE tools.
 */

export interface ToolDef {
  description: string
  schema: z.ZodType
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  endpoint: string
  /**
   * Renombra campos top-level del body antes de enviarlos al API (schema key → API key).
   * El API de CERP mezcla camelCase y snake_case según el endpoint; las tools exponen
   * SIEMPRE camelCase al modelo y este mapa absorbe la diferencia.
   */
  fieldMap?: Record<string, string>
}

// ============================================================
// "PDF editables con IA" — catalogo de fieldIds de plantillas de documento.
// Mirror de cerp-server/src/constants/documentTemplateCatalog.ts (BUDGET_FIELDS).
// Mantener en sync a mano: agregar/quitar un campo del catalogo del backend
// requiere el mismo cambio aca para que el schema Zod de update_budget_pdf_settings
// acepte/valide los fieldIds correctos.
// ============================================================
const BUDGET_HEADER_FIELD_IDS = [
  'header.companyLogo',
  'header.companyName',
  'header.clientName',
  'header.clientAddress',
  'header.clientCity',
  'header.clientCountry',
  'header.budgetNumber',
  'header.budgetRevision',
  'header.issueDate',
  'header.expiryDate',
] as const

const BUDGET_LINE_FIELD_IDS = [
  'lines.num',
  'lines.desc',
  'lines.code',
  'lines.qty',
  'lines.unit',
  'lines.material',
  'lines.labor',
  'lines.equipment',
  'lines.subcontracted',
  'lines.overhead',
  'lines.total',
] as const

export const toolSchemas: Record<string, ToolDef> = {
  // ============================================================
  // PROJECTS — Read & Write
  // ============================================================
  get_company_projects: {
    description: 'Lista los proyectos de construccion de la empresa con estado, fechas, costo y avance.',
    schema: z.object({
      status: z.enum(['budget', 'planning', 'execution', 'monitoring', 'closed']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/projects',
  },
  get_project_details: {
    description: 'Detalle completo de un proyecto: tareas, costos planificados vs reales, fechas y avance.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      includeTasks: z.boolean().optional(),
    }),
    method: 'GET',
    endpoint: '/projects/:projectId',
  },
  create_project: {
    description: 'Crea un nuevo proyecto de construccion. SIEMPRE usar status "budget" para presupuestos/licitaciones. Un proyecto en status "budget" ES el presupuesto.',
    schema: z.object({
      name: z.string().describe('Nombre del proyecto'),
      description: z.string().optional(),
      status: z.enum(['budget', 'planning', 'execution', 'paused', 'completed', 'cancelled']).optional().describe('SIEMPRE usar "budget" para presupuestos/cotizaciones'),
      start_date: z.string().optional().describe('Fecha inicio ISO 8601'),
      end_date: z.string().optional().describe('Fecha fin ISO 8601'),
      projected_cost: z.number().optional(),
      projected_income: z.number().optional(),
      currency: z.string().optional().describe('ARS, EUR, USD'),
    }),
    method: 'POST',
    endpoint: '/projects',
  },
  update_project: {
    description: 'Actualiza un proyecto existente.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['budget', 'planning', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      projected_cost: z.number().optional(),
      projected_income: z.number().optional(),
    }),
    method: 'PUT',
    endpoint: '/projects/:projectId',
  },

  // ============================================================
  // CONSTRUCTION SITES — Read & Write
  // ============================================================
  get_construction_sites: {
    description: 'Lista las obras (frentes de trabajo). Nombre, estado, ubicacion, presupuesto y centro de costes.',
    schema: z.object({
      status: z.enum(['planning', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      projectId: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/construction-sites',
  },
  get_site_cost_summary: {
    description: 'Resumen de costos de todas las obras de un proyecto.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
    }),
    method: 'GET',
    endpoint: '/construction-sites/project/:projectId/cost-summary',
  },
  create_construction_site: {
    description: 'Crea una nueva obra (frente de trabajo) dentro de un proyecto.',
    schema: z.object({
      name: z.string().describe('Nombre de la obra'),
      projectId: z.string().describe('ID del proyecto'),
      description: z.string().optional(),
      location: z.string().optional(),
      status: z.enum(['planning', 'execution', 'paused', 'completed', 'cancelled']).optional(),
    }),
    method: 'POST',
    endpoint: '/construction-sites',
  },
  update_construction_site: {
    description: 'Actualiza una obra existente.',
    schema: z.object({
      siteId: z.string().describe('ID de la obra'),
      name: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      status: z.enum(['planning', 'execution', 'paused', 'completed', 'cancelled']).optional(),
    }),
    method: 'PUT',
    endpoint: '/construction-sites/:siteId',
  },

  // ============================================================
  // CONSTRUCTION ORDERS — Read & Write
  // ============================================================
  get_construction_orders: {
    description: 'Lista ordenes de construccion con estado, obra, cantidad, costes y proveedor.',
    schema: z.object({
      status: z.enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      constructionSiteId: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/construction-orders',
  },
  get_construction_order_details: {
    description: 'Detalle de una orden: materiales, recursos, centro de costos y avance.',
    schema: z.object({
      orderId: z.string().describe('ID de la orden'),
    }),
    method: 'GET',
    endpoint: '/construction-orders/:orderId',
  },
  create_construction_order: {
    description: 'Crea una nueva orden de construccion dentro de una obra.',
    schema: z.object({
      name: z.string().describe('Nombre de la orden'),
      constructionSiteId: z.string().describe('ID de la obra'),
      description: z.string().optional(),
      unit: z.string().optional().describe('Unidad de medida'),
      plannedQuantity: z.number().optional(),
      status: z.enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled']).optional(),
    }),
    method: 'POST',
    endpoint: '/construction-orders',
  },
  update_construction_order: {
    description: 'Actualiza una orden de construccion.',
    schema: z.object({
      orderId: z.string().describe('ID de la orden'),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      plannedQuantity: z.number().optional(),
      executedQuantity: z.number().optional(),
    }),
    method: 'PUT',
    endpoint: '/construction-orders/:orderId',
  },

  // ============================================================
  // PURCHASE ORDERS — Read & Write
  // ============================================================
  get_purchase_orders: {
    description: 'Lista ordenes de compra con numero, proveedor, estado, monto y fecha de entrega.',
    schema: z.object({
      status: z.enum(['draft', 'pending', 'approved', 'ordered', 'received', 'partial_received', 'cancelled']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/purchases',
  },
  get_purchase_order_details: {
    description: 'Detalle de una orden de compra: items, proveedores, montos y recepcion.',
    schema: z.object({
      purchaseOrderId: z.string().describe('ID de la orden de compra'),
    }),
    method: 'GET',
    endpoint: '/purchases/:purchaseOrderId',
  },
  create_purchase_order: {
    description: 'Crea una nueva orden de compra.',
    schema: z.object({
      constructionSiteId: z.string().describe('ID de la obra'),
      supplierId: z.string().optional().describe('ID del proveedor'),
      items: z.array(z.object({
        itemId: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
      })).optional(),
      notes: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/purchases',
  },
  update_purchase_status: {
    description: 'Actualiza el estado de una orden de compra. IMPORTANTE: al cambiar a "ordered" se sincroniza al cashflow.',
    schema: z.object({
      purchaseOrderId: z.string().describe('ID de la orden'),
      status: z.enum(['draft', 'pending', 'approved', 'ordered', 'received', 'partial_received', 'cancelled']),
    }),
    method: 'PATCH',
    endpoint: '/purchases/:purchaseOrderId/status',
  },

  // ============================================================
  // BUDGETS — Read & Write
  // ============================================================
  get_budgets: {
    description: 'Lista proyectos/presupuestos de la empresa (en CERP los presupuestos son proyectos con status "budget"). Devuelve el projectId de cada uno. Para obtener el Budget document ID (necesario para items/chapters), usar get_budget_by_project(projectId) con el projectId devuelto aqui.',
    schema: z.object({
      status: z.enum(['budget', 'planning', 'execution', 'monitoring', 'closed']).optional().describe('Filtrar por estado. Para presupuestos en borrador usar "budget"'),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/projects',
  },
  get_budget_by_project: {
    description: 'Obtiene el presupuesto (Budget document) de un proyecto dado su projectId. USAR SIEMPRE para obtener el budgetId real despues de encontrar el proyecto con get_budgets o get_company_projects. Devuelve el Budget con su _id, name, status, capitulos y totales. El _id de la respuesta es el budgetId que se usa en get_budget_items, update_budget_item, add_budget_chapter, etc.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto (obtenido de get_budgets o get_company_projects)'),
    }),
    method: 'GET',
    endpoint: '/budgets/project/:projectId',
  },
  get_budget_details: {
    description: 'Detalle de un presupuesto con items y capitulos.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
    }),
    method: 'GET',
    endpoint: '/budgets/:budgetId',
  },
  get_budget_items: {
    description: 'Obtiene los items/partidas de un presupuesto.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
    }),
    method: 'GET',
    endpoint: '/budgets/:budgetId/items',
  },
  // ------------------------------------------------------------
  // PDF editables con IA: reemplaza la vieja config GLOBAL de
  // ModuleSettings.budget.pdfFields (PUT /module-settings/budget fue
  // ELIMINADO del backend). Ahora cada empresa puede tener HASTA 3
  // PLANTILLAS de documento por docType (hoy solo 'BUDGET'), una marcada
  // como predeterminada (isDefault). Catalogo completo de campos en
  // cerp-server/src/constants/documentTemplateCatalog.ts.
  // ------------------------------------------------------------
  get_budget_pdf_settings: {
    description: 'Lista las plantillas de PDF de presupuestos de la empresa (hasta 3, docType BUDGET). Cada plantilla trae su config COMPLETA: header (10 campos: logo empresa, nombre empresa, nombre/direccion/localidad/pais del cliente, numero/revision/fecha emision/fecha validez del presupuesto), lines (11 columnas de la tabla de partidas), sections (1 campo: Coeficiente K - Costos Indirectos) y footer (texto libre con {{variables}}). Cada plantilla tiene isDefault (la que se usa para generar/imprimir PDFs si no se elige otra explicitamente) e isSystem (plantilla de fabrica: solo se le puede cambiar isDefault, todo lo demas es de solo lectura). Llamar SIEMPRE antes de update_budget_pdf_settings para: (1) obtener el templateId de la plantilla a editar (normalmente la que tiene isDefault:true), (2) revisar si esa plantilla es isSystem — si lo es, avisar al usuario ANTES de intentar editarla (ver la description de update_budget_pdf_settings), (3) usar su config actual como base, porque el PUT reemplaza cada grupo (header/lines/sections/footer) por completo, sin merge parcial.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/document-templates?docType=BUDGET',
  },
  update_budget_pdf_settings: {
    description: 'Edita UNA plantilla puntual de PDF de presupuestos (columnas visibles/orden de la tabla, campos de cabecera visibles/orden, seccion de Coeficiente K, texto de pie de pagina) o la marca como predeterminada de la empresa. YA NO es una config global unica: hay hasta 3 plantillas por empresa (docType BUDGET) y esta tool opera sobre UNA via su templateId (obtenido de get_budget_pdf_settings). REGLA CRITICA — el backend REEMPLAZA cada grupo enviado por completo, no hace merge: si se manda "config", hay que incluir los 4 grupos completos (header con sus 10 fieldIds, lines con sus 11, sections con su 1, y footer) — omitir un grupo o mandar solo algunos fieldIds de un grupo hace que el PUT falle o borre el resto de esa lista. Flujo correcto: leer la config actual completa con get_budget_pdf_settings, modificar SOLO la entrada (visible y/o order) del campo pedido, y reenviar TODO el resto identico. Campos mandatory (header.clientName, header.budgetNumber, header.issueDate, lines.desc, lines.total) no se pueden ocultar (visible:false) — el backend lo rechaza. Maximo 7 columnas de "lines" con visible:true simultaneamente. BLOQUEO DE PLANTILLA DE SISTEMA: si la plantilla es isSystem:true (caso comun: la default de una empresa que nunca personalizo nada), esta tool SOLO puede cambiar isDefault — cualquier otro campo (name, config) es rechazado por el backend con code SYSTEM_TEMPLATE_LOCKED. CERP-IA hoy NO puede duplicar plantillas: si el usuario pide personalizar el PDF y la plantilla default es isSystem, explicale que debe duplicarla primero desde la app web (Ajustes > Presupuestos > Plantillas de PDF), marcar la copia como predeterminada, y volver a pedir el cambio desde ahi — no intentes el PUT igual, va a fallar. Requiere permiso de edicion de ajustes (settings:edit + feature edit_pdf_templates).',
    schema: z.object({
      templateId: z.string().describe('ID de la plantilla a editar (obtenido de get_budget_pdf_settings; normalmente la que tiene isDefault:true)'),
      name: z.string().optional().describe('Nuevo nombre de la plantilla, para renombrarla. Rechazado por el backend si la plantilla es isSystem.'),
      isDefault: z.boolean().optional().describe('Marca esta plantilla como la predeterminada de la empresa para BUDGET (desmarca automaticamente la anterior default). Es el UNICO campo modificable en una plantilla isSystem.'),
      config: z.object({
        header: z.array(z.object({
          fieldId: z.enum(BUDGET_HEADER_FIELD_IDS).describe('ID del campo de cabecera del catalogo'),
          visible: z.boolean().describe('Mostrar u ocultar el campo. header.clientName, header.budgetNumber y header.issueDate son obligatorios: no se pueden poner en false.'),
          order: z.number().int().min(0).describe('Posicion del campo dentro de su columna (Datos del Cliente o Datos del Presupuesto)'),
        })).optional().describe('Los 10 fieldIds de header del catalogo, TODOS, no solo el que cambia. Requerido si se manda "config".'),
        lines: z.array(z.object({
          fieldId: z.enum(BUDGET_LINE_FIELD_IDS).describe('ID de columna de la tabla de partidas del catalogo'),
          visible: z.boolean().describe('Mostrar u ocultar la columna. lines.desc y lines.total son obligatorias: no se pueden poner en false.'),
          order: z.number().int().min(0).describe('Posicion de la columna en la tabla, de izquierda a derecha'),
        })).optional().describe('Los 11 fieldIds de lines del catalogo (#, Descripcion, Codigo, Cantidad, Unidad, Material, Mano de Obra, Equipos, Subcontratado, Gastos generales, Total), TODOS, no solo el que cambia. Maximo 7 con visible:true. Requerido si se manda "config".'),
        sections: z.array(z.object({
          fieldId: z.literal('section.indirectCosts').describe('Unica seccion configurable hoy'),
          visible: z.boolean().describe('Mostrar/ocultar la seccion completa de Coeficiente K - Costos Indirectos (tambien oculta las filas relacionadas dentro del Resumen del presupuesto)'),
          order: z.number().int().min(0),
        })).optional().describe('Array de 1 elemento (section.indirectCosts). Requerido si se manda "config".'),
        footer: z.object({
          text: z.string().max(2000).describe('Texto libre del pie de pagina. Variables permitidas: {{company.name}}, {{company.taxId}}, {{company.address}}, {{company.phone}}, {{company.email}}, {{budget.number}}, {{budget.issueDate}}, {{budget.expiryDate}}, {{client.name}}. Cualquier otra variable es rechazada por el backend.'),
        }).optional().describe('Texto completo del pie de pagina (reemplaza el anterior). Requerido si se manda "config".'),
      }).optional().describe('Config a reemplazar, COMPLETA: si se envia este campo, header/lines/sections/footer deben venir los 4 juntos y cada array con TODOS sus fieldIds del catalogo (no un subconjunto). Omitir "config" entero si solo se quiere cambiar name o isDefault.'),
    }),
    method: 'PUT',
    endpoint: '/document-templates/:templateId',
  },
  create_budget: {
    description: 'Crea un nuevo presupuesto de construccion para un proyecto.',
    schema: z.object({
      name: z.string().describe('Nombre del presupuesto'),
      projectId: z.string().describe('ID del proyecto'),
      description: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/budgets',
  },
  add_budget_chapter: {
    description: 'Agrega un capitulo (agrupacion) al presupuesto. Para guardar la descripcion del capitulo, siempre llamar a update_budget_item despues con el ID devuelto.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      name: z.string().describe('Nombre del capitulo'),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/chapters',
  },
  update_budget_item: {
    description: 'Actualiza campos de un item o chapter de presupuesto ya creado. Usar principalmente para agregar o editar la descripcion de un rubro (chapter) despues de crearlo, ya que el POST de creacion no acepta description. Tambien sirve para renombrar o cambiar cantidad.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      itemId: z.string().describe('ID del item o chapter a actualizar (obtenido de la respuesta de add_budget_chapter o add_budget_items_batch)'),
      description: z.string().optional().describe('Descripcion libre del rubro. Aparece impresa en el PDF bajo el nombre del capitulo. Solo se renderiza en chapters (no en items hoja). Pasar string vacio "" para borrar.'),
      name: z.string().optional().describe('Nuevo nombre del item/chapter (para renombrar)'),
      quantity: z.number().optional().describe('Nueva cantidad'),
      overheadOverride: z.number().optional().describe('Override % gastos generales'),
    }),
    method: 'PUT',
    endpoint: '/budgets/:budgetId/items/:itemId',
  },
  delete_budget_item: {
    description: 'Elimina un item o capitulo del presupuesto (borrado logico) JUNTO CON TODOS SUS DESCENDIENTES (subcapitulos e items hijos). Recalcula automaticamente la numeracion jerarquica y los totales del presupuesto. IRREVERSIBLE desde la IA: confirmar SIEMPRE con el usuario antes, indicando cuantos items se van a borrar.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      itemId: z.string().describe('ID del item o capitulo a eliminar (con sus descendientes)'),
    }),
    method: 'DELETE',
    endpoint: '/budgets/:budgetId/items/:itemId',
  },
  reorder_budget_items: {
    description: 'Reordena los items/capitulos hijos de un mismo padre dentro del presupuesto. Sirve para mover un item de posicion dentro de su capitulo o reordenar capitulos. IMPORTANTE: solo reordena hermanos bajo el MISMO padre — enviar la lista COMPLETA de IDs de los hijos de ese padre en el orden final deseado. Para mover un item a OTRO capitulo, usar delete_budget_item + add_budget_item en el capitulo destino.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      parentItemId: z.string().optional().describe('ID del capitulo padre cuyos hijos se reordenan. Omitir para reordenar los capitulos raiz del presupuesto'),
      orderedItemIds: z.array(z.string()).min(1).describe('TODOS los IDs de los hijos directos de ese padre, en el orden final deseado'),
    }),
    method: 'PUT',
    endpoint: '/budgets/:budgetId/items/reorder',
  },
  replace_budget_item_product: {
    description: 'Reemplaza el producto/APU de un item de presupuesto existente por uno NUEVO con composicion completa (materiales + recursos). Usar cuando hay que corregir o completar el desglose (BOM) de un item ya cargado — por ejemplo agregar materiales que faltaron — ya que update_budget_item NO permite editar la composicion. Crea un producto nuevo en el catalogo (el code debe ser unico), lo vincula al item y recalcula costos y totales. Los materiales y recursos referenciados deben existir en el catalogo (usar search_materials / search_resources / create_material antes).',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      itemId: z.string().describe('ID del item de presupuesto cuyo producto se reemplaza (debe ser un item hoja con producto vinculado, no un capitulo)'),
      name: z.string().describe('Nombre del nuevo producto/APU'),
      code: z.string().describe('Codigo UNICO del nuevo producto (ej: "PART-7.1.8-V2"). Si el original era MAT-0042, usar un sufijo tipo MAT-0042-B'),
      unit: z.string().describe('Unidad de medida (m2, m3, u, gl, etc.)'),
      description: z.string().optional().describe('Descripcion del producto. Si se omite se conserva la del producto original'),
      classification: z.string().optional().describe('ID classification product_type. Si se omite se conserva la del original'),
      materialsRequired: z.array(z.object({
        material_id: z.string().describe('ID del material existente en el catalogo'),
        quantity_needed: z.number().describe('Cantidad del material por 1 unidad del item'),
        unitCost: z.number().optional().describe('Costo unitario especifico para esta receta. Si se omite se usa el defaultCost del material'),
      })).optional().describe('BOM de materiales del nuevo producto'),
      resourcesRequired: z.array(z.object({
        resourceId: z.string().describe('ID del recurso existente (mano de obra o maquinaria)'),
        resourceName: z.string().optional().describe('Nombre del recurso (informativo)'),
        quantity: z.number().describe('Unidades del recurso en paralelo. DEFAULT 1 — NUNCA poner aca las horas'),
        hoursPerUnit: z.number().optional().describe('Horas (o dias si costRateType="daily") planificadas por 1 unidad del item'),
        costRate: z.number().optional().describe('Tarifa del recurso'),
        costRateType: z.enum(['hourly', 'daily', 'fixed', 'unit', 'm2', 'm3']).optional(),
        estimatedCost: z.number().describe('Costo del recurso en este APU: hoursPerUnit x costRate. OBLIGATORIO, el backend no lo calcula'),
      })).optional().describe('BOM de recursos del nuevo producto'),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/items/:itemId/replace-product',
    fieldMap: { materialsRequired: 'materials_required', resourcesRequired: 'resources_required' },
  },
  add_budget_item: {
    description: 'Agrega un item/partida al presupuesto. REQUIERE un productId del catalogo de materiales de la empresa. Primero busca el producto con search_materials, y si no existe, crealo con create_material.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      productId: z.string().describe('ID del producto/material del catalogo (OBLIGATORIO). Usar search_materials para encontrarlo o create_material para crearlo'),
      quantity: z.number().describe('Cantidad'),
      parentItemId: z.string().optional().describe('ID del capitulo padre donde insertar el item'),
      overheadOverride: z.number().optional().describe('Override del porcentaje de gastos generales'),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/items',
  },
  add_budget_items_batch: {
    description: 'Agrega MULTIPLES items/partidas al presupuesto en UNA sola llamada. MUCHO mas eficiente que add_budget_item individual. Puede crear productos nuevos y agregarlos al presupuesto en un solo paso. USAR SIEMPRE en vez de add_budget_item cuando hay mas de 3 items. Para items compuestos (APU - Analisis de Precio Unitario) SIEMPRE enviar materialsRequired y/o resourcesRequired con el desglose real; NO enviar solo costBreakdown agregado, el backend recalcula el costo desde el BOM si este existe.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      items: z.array(z.object({
        productId: z.string().optional().describe('ID del producto existente (si ya existe en catalogo)'),
        quantity: z.number().describe('Cantidad'),
        parentItemId: z.string().describe('ID del capitulo padre'),
        overheadOverride: z.number().optional().describe('Override % gastos generales'),
        newProduct: z.object({
          name: z.string().describe('Nombre del material o partida'),
          code: z.string().optional().describe('Codigo unico (ej: "EXC-ZANJAS-001"). OPCIONAL: si no se envia, el backend genera uno con prefijo MAT- y numero correlativo.'),
          unit: z.string().optional().describe('Unidad (m2, m3, kg, u, gl)'),
          description: z.string().optional(),
          classification: z.string().optional().describe('ID classification product_type'),
          defaultCost: z.number().optional().describe('Costo unitario directo. Ignorado si se envia materialsRequired/resourcesRequired (el backend recalcula desde el BOM).'),
          costBreakdown: z.object({
            materials: z.number().optional(),
            labor: z.number().optional(),
            equipment: z.number().optional(),
            subcontracted: z.number().optional(),
          }).optional().describe('Desglose agregado. SOLO valido para items simples sin BOM. Si envias materialsRequired o resourcesRequired este campo se ignora y el costo se calcula desde el BOM.'),
          materialsRequired: z.array(z.object({
            materialId: z.string().optional().describe('ID del material existente en catalogo. Usar search_materials primero. Excluyente con newMaterial.'),
            newMaterial: z.object({
              name: z.string().describe('Nombre del material (ej: "Cemento Portland 50kg")'),
              code: z.string().optional().describe('Codigo unico. Si se omite, el backend lo genera con prefijo MAT-.'),
              unit: z.string().optional().describe('Unidad de medida (kg, m3, u, etc.)'),
              description: z.string().optional(),
              classification: z.string().optional().describe('ID classification product_type'),
              defaultCost: z.number().optional().describe('Costo unitario del material. OBLIGATORIO preguntar al usuario si no esta en el archivo fuente. NUNCA inventar.'),
            }).optional().describe('Material nuevo a crear si no existe en catalogo. Excluyente con materialId.'),
            quantityNeeded: z.number().describe('Cantidad de este material necesaria para producir 1 unidad del item (ej: 0.35 m3 de hormigon por m2 de losa)'),
            unitCost: z.number().optional().describe('Costo unitario especifico para esta receta. Si se omite, se usa el defaultCost del material.'),
          })).optional().describe('BOM de materiales del item. Obligatorio para items compuestos (APU).'),
          resourcesRequired: z.array(z.object({
            resourceId: z.string().optional().describe('ID del recurso existente (mano de obra o maquinaria). Usar search_resources primero. Excluyente con newResource.'),
            newResource: z.object({
              name: z.string().describe('Nombre del recurso (ej: "Oficial Albañil", "Retroexcavadora CAT 320")'),
              code: z.string().optional().describe('Codigo unico. Si se omite, el backend lo genera con prefijo MO- (labor) o EQ- (tools_machinery).'),
              type: z.enum(['labor', 'tools_machinery']).describe('"labor" para personas (oficiales, ayudantes, especialistas). "tools_machinery" para maquinaria y herramientas. Inferir cuando es obvio por el nombre; preguntar al usuario si es ambiguo.'),
              costRate: z.number().describe('Costo unitario del recurso (€/hora, €/dia, etc.). OBLIGATORIO preguntar al usuario si no esta en el archivo fuente.'),
              costRateType: z.enum(['hourly', 'daily', 'fixed', 'unit', 'm2', 'm3']).optional().describe('Unidad del costo. Default "hourly".'),
              description: z.string().optional(),
            }).optional().describe('Recurso nuevo a crear si no existe. Excluyente con resourceId.'),
            quantity: z.number().describe('Numero de UNIDADES del recurso que trabajan en paralelo (ej: 2 oficiales a la vez). DEFAULT 1, salvo que el usuario explicite mas de uno. NUNCA poner aqui las horas/dias planificados.'),
            hoursPerUnit: z.number().optional().describe('Horas (o dias si costRateType="daily") PLANIFICADAS de este recurso por 1 unidad del item. AQUI van las horas estimadas. Mandar SIEMPRE: sin este valor el recurso queda en 0 horas.'),
            estimatedCost: z.number().optional().describe('Costo del recurso en este APU. OBLIGATORIO mandarlo: el backend NO lo calcula. Formula: hoursPerUnit × costRate (tarifa del recurso). Si se omite, el recurso aporta 0 al costo del item.'),
          })).optional().describe('BOM de recursos productivos (mano de obra + maquinaria) del item. Obligatorio para items compuestos (APU).'),
        }).optional().describe('Producto nuevo a crear. Usar SOLO si no existe productId. Si es un APU compuesto, llenar materialsRequired y resourcesRequired.'),
      })).describe('Array de items a crear (max 200 por batch)'),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/items/batch',
  },
  approve_budget: {
    description: 'Aprueba un presupuesto (cambia estado a approved). Crea obra, almacen, tareas y ordenes automaticamente.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/approve',
  },
  update_cost_items: {
    description: 'Configura los costos indirectos del presupuesto: Gastos Generales (GG), Beneficio Industrial (BI), IVA y otros. Cada item tiene un grupo: 1=pre-financiero, 2=financiero, 3=impuestos. Los porcentajes se aplican sobre el subtotal del grupo anterior.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      costItems: z.array(z.object({
        order: z.number().describe('Orden de aplicacion'),
        name: z.string().describe('Nombre del costo (ej: "Gastos Generales", "Beneficio Industrial", "IVA")'),
        costType: z.enum(['calculated', 'variable', 'fixed']).describe('"calculated" aplica % automaticamente'),
        percentage: z.number().optional().describe('Porcentaje a aplicar (ej: 13 para GG, 6 para BI, 21 para IVA)'),
        fixedAmount: z.number().optional().describe('Monto fijo (solo para costType "fixed")'),
        group: z.number().min(1).max(3).describe('Grupo: 1=gastos generales, 2=financieros, 3=impuestos'),
      })).describe('Array de costos indirectos a configurar'),
    }),
    method: 'PUT',
    endpoint: '/budgets/:budgetId/cost-items',
  },
  recalculate_budget: {
    description: 'Recalcula TODOS los costos del presupuesto: items, capitulos, totales y costos finales. Llamar despues de agregar o modificar items.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/recalculate',
  },
  get_products: {
    description: 'Lista los productos/materiales del catalogo de la empresa con su desglose de costos (materiales, mano de obra, equipos, subcontratado). Util para buscar productos existentes antes de agregar items al presupuesto.',
    schema: z.object({
      search: z.string().optional().describe('Texto de busqueda por nombre o codigo'),
      limit: z.number().min(1).max(100).optional().describe('Limite de resultados (default 50)'),
    }),
    method: 'GET',
    endpoint: '/budgets/products',
  },

  // ============================================================
  // TASKS — Read & Write
  // ============================================================
  get_task_details: {
    description: 'Detalle de una tarea: subtareas, centro de costos, estado.',
    schema: z.object({
      taskId: z.string().describe('ID de la tarea'),
    }),
    method: 'GET',
    endpoint: '/tasks/:taskId',
  },
  get_project_tasks: {
    description: 'Lista las tareas de un proyecto con subtareas anidadas.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
    }),
    method: 'GET',
    endpoint: '/projects/:projectId/tasks-with-subtasks',
  },
  create_task: {
    description: 'Crea una nueva tarea dentro de un proyecto. Los campos name, startDate, endDate y status son OBLIGATORIOS (el API los exige). Para el cronograma de obra: crear las tareas con sus fechas reales de inicio y fin.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      name: z.string().describe('Nombre de la tarea'),
      startDate: z.string().describe('Fecha de inicio ISO 8601 (ej: "2026-07-01"). OBLIGATORIO'),
      endDate: z.string().describe('Fecha de fin ISO 8601. OBLIGATORIO'),
      status: z.enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled']).describe('Estado inicial. OBLIGATORIO. Usar "planning" para tareas de cronograma futuro, "pending" si esta lista para arrancar'),
      description: z.string().optional(),
      parentTaskId: z.string().optional().describe('ID de tarea padre (para subtareas)'),
    }),
    method: 'POST',
    endpoint: '/projects/:projectId/tasks',
    fieldMap: { parentTaskId: 'parent_task_id' },
  },
  update_task: {
    description: 'Actualiza una tarea existente: nombre, descripcion, estado, fechas de inicio/fin, prioridad y avance. Usar para cargar o corregir el cronograma (fechas) de tareas ya creadas. NOTA: si la tarea tiene subtareas, el progreso se calcula automaticamente y no se puede setear a mano.',
    schema: z.object({
      taskId: z.string().describe('ID de la tarea'),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      startDate: z.string().optional().describe('Nueva fecha de inicio ISO 8601'),
      endDate: z.string().optional().describe('Nueva fecha de fin ISO 8601'),
      priority: z.enum(['None', 'Low', 'Medium', 'High']).optional().describe('Prioridad de la tarea'),
      progress: z.number().min(0).max(100).optional().describe('Porcentaje de avance (0-100). Solo en tareas SIN subtareas'),
    }),
    method: 'PUT',
    endpoint: '/tasks/:taskId',
    fieldMap: { startDate: 'start_date', endDate: 'end_date', progress: 'percent_complete' },
  },
  delete_task: {
    description: 'Elimina una tarea del proyecto (borrado logico). Usar con cuidado: confirmar con el usuario antes de borrar.',
    schema: z.object({
      taskId: z.string().describe('ID de la tarea a eliminar'),
    }),
    method: 'DELETE',
    endpoint: '/tasks/:taskId',
  },
  create_tasks_batch: {
    description:
      'Crea MULTIPLES tareas de cronograma en un proyecto en UNA sola llamada, de forma IDEMPOTENTE y reanudable. USAR SIEMPRE en vez de create_task cuando hay mas de 3 tareas (cronogramas, planes de obra). Enviar los PADRES ANTES que sus hijos en el array y referenciarlos con parentKey. REANUDACION: si la carga se corta (timeout, cierre de la app), REPETIR la misma llamada con el MISMO lote completo — las tareas ya creadas se saltan (skipped) y solo se crean las faltantes, sin duplicar. El conector trocea lotes grandes en bloques de 50 automaticamente. El resultado incluye summary {created, skipped, errors} y el detalle por tarea.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      tasks: z
        .array(
          z.object({
            key: z
              .string()
              .optional()
              .describe(
                'Clave ESTABLE y unica de la tarea dentro del proyecto (ej: el codigo de partida "3.2.1" o "cim-01"). Usarla siempre que el cronograma tenga codigos. Al reintentar una carga interrumpida, REUSAR exactamente las mismas claves: son lo que evita duplicados. Si se omite, el conector deriva una clave de nombre+fechas+padre'
              ),
            name: z.string().describe('Nombre de la tarea'),
            startDate: z.string().describe('Fecha de inicio ISO 8601 (ej: "2026-08-01"). OBLIGATORIO'),
            endDate: z.string().describe('Fecha de fin ISO 8601. OBLIGATORIO'),
            status: z
              .enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled'])
              .describe('Estado inicial. Usar "planning" para cronograma futuro'),
            description: z.string().optional(),
            parentKey: z
              .string()
              .optional()
              .describe('key de la tarea padre DE ESTE MISMO lote (el padre debe aparecer ANTES en el array). Excluyente con parentTaskId'),
            parentTaskId: z
              .string()
              .optional()
              .describe('ID de una tarea padre YA existente en el proyecto. Excluyente con parentKey'),
          })
        )
        .min(1)
        .max(200)
        .describe('Tareas a crear, padres antes que hijos. Max 200 por llamada'),
    }),
    method: 'POST',
    endpoint: '/projects/:projectId/tasks/batch',
  },

  // ============================================================
  // FINANCE — Read & Write
  // ============================================================
  get_project_cashflow: {
    description: 'Cashflow de un proyecto: costos presupuestados vs reales, ingresos, metricas.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
    }),
    method: 'GET',
    endpoint: '/projects/:projectId/cashflow',
  },
  get_cashflow_metrics: {
    description: 'Metricas financieras del cashflow: margen, ROI, varianza.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
    }),
    method: 'GET',
    endpoint: '/projects/:projectId/cashflow/metrics',
  },
  get_expenses: {
    description: 'Lista gastos registrados. Filtra por obra o rango de fechas.',
    schema: z.object({
      constructionSiteId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/finance/expenses',
  },
  create_expense: {
    description: 'Registra un nuevo gasto.',
    schema: z.object({
      constructionSiteId: z.string().describe('ID de la obra'),
      amount: z.number().describe('Monto del gasto'),
      description: z.string().describe('Descripcion del gasto'),
      category: z.string().optional(),
      date: z.string().optional().describe('Fecha ISO 8601'),
    }),
    method: 'POST',
    endpoint: '/finance/expenses',
  },
  create_income: {
    description: 'Registra un nuevo ingreso.',
    schema: z.object({
      constructionSiteId: z.string().describe('ID de la obra'),
      amount: z.number().describe('Monto del ingreso'),
      description: z.string().describe('Descripcion'),
      date: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/finance/incomes',
  },
  get_financial_summary: {
    description: 'Resumen financiero general: totales de ingresos, gastos, balance.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/finance/summary',
  },

  // ============================================================
  // MATERIALS & WAREHOUSE — Read & Write
  // ============================================================
  search_materials: {
    description: 'Busca materiales/insumos en inventario por nombre, codigo o stock bajo.',
    schema: z.object({
      searchTerm: z.string().optional(),
      lowStock: z.boolean().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/items',
  },
  search_resources: {
    description: 'Busca recursos productivos (mano de obra y maquinaria) en el catalogo de la empresa por nombre o codigo. Usar ANTES de crear un recurso nuevo, para evitar duplicados.',
    schema: z.object({
      searchTerm: z.string().min(1).describe('Texto de busqueda por nombre o codigo del recurso. OBLIGATORIO: usar al menos una palabra clave del nombre del recurso buscado para evitar listar todo el catalogo.'),
      type: z.enum(['labor', 'tools_machinery']).optional().describe('Filtrar por tipo de recurso: "labor" para mano de obra, "tools_machinery" para maquinaria/herramientas'),
      limit: z.number().min(1).max(50).optional().describe('Limite de resultados (default 20)'),
    }),
    method: 'GET',
    endpoint: '/resources',
  },
  create_material: {
    description: 'Crea un nuevo material/item en el inventario. IMPORTANTE: siempre enviar code unico Y classification (usar get_classifications para obtener el ID de tipo product_type).',
    schema: z.object({
      name: z.string().describe('Nombre del material'),
      code: z.string().optional().describe('Codigo unico (ej: "EXC-ZANJAS-001"). SIEMPRE enviarlo para evitar colisiones.'),
      unit: z.string().optional().describe('Unidad (kg, m, m2, m3, u, gl, etc.)'),
      description: z.string().optional().describe('Descripcion detallada del material'),
      classification: z.string().optional().describe('ID de la clasificacion (OBLIGATORIO para que aparezca en presupuestos). Usar get_classifications para obtener el ID de tipo product_type.'),
      defaultCost: z.number().optional().describe('Costo unitario por defecto'),
      costBreakdown: z.object({
        materials: z.number().optional().describe('Costo de materiales por unidad'),
        labor: z.number().optional().describe('Costo de mano de obra por unidad'),
        equipment: z.number().optional().describe('Costo de equipos por unidad'),
        subcontracted: z.number().optional().describe('Costo subcontratado por unidad'),
      }).optional().describe('Desglose de costos unitarios'),
      category: z.string().optional(),
      minimumStock: z.number().optional(),
    }),
    method: 'POST',
    endpoint: '/items',
  },
  get_classifications: {
    description: 'Obtiene las clasificaciones de productos de la empresa. Buscar la que tenga type "product_type" — su ID es OBLIGATORIO al crear materiales para que aparezcan en presupuestos.',
    schema: z.object({
      type: z.string().optional().describe('Filtrar por tipo (ej: "product_type")'),
    }),
    method: 'GET',
    endpoint: '/classifications',
  },
  get_warehouse_stock: {
    description: 'Inventario por almacen: materiales, stock actual, reservado y minimo.',
    schema: z.object({
      warehouseId: z.string().optional(),
      lowStock: z.boolean().optional(),
      limit: z.number().min(1).max(100).optional(),
    }),
    method: 'GET',
    endpoint: '/warehouses',
  },
  get_global_stock: {
    description: 'Stock global consolidado de todos los almacenes.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/warehouses/global-stock',
  },
  create_warehouse_transfer: {
    description: 'Crea una transferencia de materiales entre almacenes.',
    schema: z.object({
      sourceWarehouseId: z.string().describe('ID almacen origen'),
      targetWarehouseId: z.string().describe('ID almacen destino'),
      items: z.array(z.object({
        itemId: z.string(),
        quantity: z.number(),
      })),
      notes: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/warehouse-transfers',
  },

  // ============================================================
  // DELIVERY NOTES
  // ============================================================
  get_delivery_notes: {
    description: 'Lista albaranes de entrega (notas de recepcion).',
    schema: z.object({
      purchaseOrderId: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/delivery-notes',
  },

  // ============================================================
  // RESOURCES — Read & Write
  // ============================================================
  get_resources: {
    description: 'Recursos productivos (mano de obra, maquinaria). Disponibilidad, costos, asignaciones.',
    schema: z.object({
      type: z.enum(['labor', 'tools_machinery']).optional(),
      status: z.enum(['available', 'occupied', 'maintenance', 'retired']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/resources',
  },
  create_resource: {
    description: 'Crea un nuevo recurso (trabajador, maquinaria, herramienta).',
    schema: z.object({
      name: z.string().describe('Nombre del recurso'),
      type: z.enum(['labor', 'tools_machinery']),
      status: z.enum(['available', 'occupied', 'maintenance', 'retired']).optional(),
      costPerHour: z.number().optional(),
      costPerDay: z.number().optional(),
    }),
    method: 'POST',
    endpoint: '/resources',
  },
  assign_resource: {
    description: 'Asigna un recurso a una orden de construccion.',
    schema: z.object({
      resourceId: z.string().describe('ID del recurso'),
      constructionOrderId: z.string().describe('ID de la orden'),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/resources/:resourceId/assign',
  },

  // ============================================================
  // CONTACTS — Read & Write
  // ============================================================
  search_contacts: {
    description: 'Busca contactos (proveedores, clientes, subcontratistas) por nombre, email o tipo.',
    schema: z.object({
      searchTerm: z.string().optional(),
      type: z.enum(['individual', 'company']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/contacts',
  },
  create_contact: {
    description: 'Crea un nuevo contacto (proveedor, cliente, subcontratista).',
    schema: z.object({
      name: z.string().describe('Nombre del contacto'),
      type: z.enum(['individual', 'company']),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      notes: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/contacts',
  },

  // ============================================================
  // PRODUCTION REPORTS — Read & Write
  // ============================================================
  get_production_reports: {
    description: 'Lista reportes de produccion de una obra.',
    schema: z.object({
      siteId: z.string().describe('ID de la obra'),
    }),
    method: 'GET',
    endpoint: '/production-reports/site/:siteId',
  },
  create_production_report: {
    description: 'Crea un reporte de produccion para una obra.',
    schema: z.object({
      constructionSiteId: z.string().describe('ID de la obra'),
      constructionOrderId: z.string().optional().describe('ID de la orden'),
      date: z.string().optional(),
      notes: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/production-reports',
  },

  // ============================================================
  // WORK CERTIFICATIONS — Read & Write
  // ============================================================
  get_work_certifications: {
    description: 'Lista certificaciones de obra.',
    schema: z.object({
      constructionSiteId: z.string().optional(),
    }),
    method: 'GET',
    endpoint: '/work-certifications',
  },
  create_work_certification: {
    description: 'Crea una nueva certificacion de obra.',
    schema: z.object({
      constructionSiteId: z.string().describe('ID de la obra'),
      name: z.string().optional(),
      notes: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/work-certifications',
  },

  // ============================================================
  // DAILY REPORTS
  // ============================================================
  create_daily_report: {
    description: 'Crea un parte diario de obra.',
    schema: z.object({
      constructionSiteId: z.string().describe('ID de la obra'),
      date: z.string().optional(),
      weather: z.string().optional(),
      notes: z.string().optional(),
      workersCount: z.number().optional(),
    }),
    method: 'POST',
    endpoint: '/daily-reports',
  },

  // ============================================================
  // STATISTICS & ANALYTICS
  // ============================================================
  get_purchase_stats: {
    description: 'Estadisticas de compras: totales, por estado, por proveedor.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/purchases/stats',
  },
  get_warehouse_stats: {
    description: 'Estadisticas de almacen: movimientos, valoracion, alertas.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/warehouses/stats',
  },
  get_resource_utilization: {
    description: 'Reporte de utilizacion de recursos: ocupacion, costos, disponibilidad.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/resources/reports/utilization',
  },
  get_contact_stats: {
    description: 'Estadisticas de contactos: total por tipo, proveedores activos.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/contacts/stats',
  },
  get_low_stock_alerts: {
    description: 'Alertas de materiales con stock bajo el minimo.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/items/low-stock',
  },

  // ============================================================
  // COMPANY & USER — Read & Write
  // ============================================================
  get_company_info: {
    description: 'Obtiene informacion completa de la empresa: nombre, datos fiscales (CUIT/NIF), direccion, telefono, industria, suscripcion, y todas las configuraciones.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/companies/settings',
  },
  get_company_settings: {
    description: 'Configuracion de la empresa: datos fiscales (legalName, taxId/CUIT/NIF), direccion, moneda, formato de numeros, modulos habilitados, permisos globales.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/companies/settings',
  },
  update_company_settings: {
    description: 'Actualiza configuracion de la empresa: datos fiscales, direccion, moneda, formato regional.',
    schema: z.object({
      businessInfo: z.object({
        legalName: z.string().optional(),
        commercialName: z.string().optional(),
        taxId: z.string().optional().describe('CUIT/NIF/Tax ID fiscal'),
        industry: z.string().optional(),
        website: z.string().optional(),
        phone: z.string().optional(),
      }).optional(),
      address: z.object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional().describe('ISO 3166-1 alpha-2: AR, ES, US'),
      }).optional(),
      regional: z.object({
        currency: z.string().optional().describe('ISO 4217: ARS, EUR, USD'),
        locale: z.string().optional().describe('es-AR, es-ES, en-US'),
        timezone: z.string().optional(),
        dateFormat: z.string().optional().describe('DD/MM/YYYY o MM/DD/YYYY'),
      }).optional(),
    }),
    method: 'PUT',
    endpoint: '/companies/settings',
  },
  get_currency_settings: {
    description: 'Configuracion de moneda de la empresa: codigo, simbolo, formato.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/companies/settings/currency',
  },
  get_current_user: {
    description: 'Obtiene datos del usuario actual: nombre, email, roles, permisos, empresa asociada.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/users/me',
  },
  get_company_users: {
    description: 'Lista todos los usuarios de la empresa con sus roles y permisos.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/users/company',
  },

  // ============================================================
  // QUOTES — Monetización de Cotización con IA
  // ============================================================
  quote_eligibility: {
    description: 'OBLIGATORIO antes de generar una cotización. Devuelve si la empresa puede generar cotización ahora, si tiene una gratis disponible (trial o mensual), o si debe pagar €19,99. Bloquea si la subscripción no está activa.',
    schema: z.object({}),
    method: 'GET',
    endpoint: '/quotes/eligibility',
  },
  quote_consume_free: {
    description: 'Consume la cotización gratis disponible (trial o mensual). Llamar SOLO si quote_eligibility devolvió freeAvailable=true. Devuelve el quote creado con su id.',
    schema: z.object({
      source: z.enum(['trial_free', 'monthly_free']).describe('Fuente de la free quote según quote_eligibility.freeSource'),
    }),
    method: 'POST',
    endpoint: '/quotes/consume-free',
  },
  quote_consume_unlimited: {
    description: 'Registra una cotización para empresas con el plan CERP IA Ilimitado. Llamar SOLO si quote_eligibility devolvió unlimited=true. No hay cobro ni consumo de cuota. Devuelve el quote creado con su id para usarlo en quote_register_files.',
    schema: z.object({}),
    method: 'POST',
    endpoint: '/quotes/consume-unlimited',
  },
  quote_purchase_extra: {
    description: 'Cobra €19,99 al método de pago guardado (off-session). PEDIR CONFIRMACIÓN AL USUARIO ANTES de llamar esto. Si Stripe pide autenticación adicional (SCA), devolverá fallbackCheckoutUrl que el usuario debe abrir.',
    schema: z.object({}),
    method: 'POST',
    endpoint: '/quotes/purchase-extra',
  },
  quote_reserve: {
    description:
      'CORTAFUEGOS — Reserva un crédito para la cotización SIN cobrar ni consumir (deja un hold). Llamar UNA SOLA VEZ al arrancar el flujo de cotización, después de quote_eligibility y de la confirmación del usuario. El backend decide la fuente automáticamente (ilimitado → gratis → crédito prepago → pago €19,99 con autorización retenida). Devuelve { quoteId, source, lifecycle:"reserved", requiresAction }. Guardá el quoteId: lo usás en quote_commit al final. El cobro/consumo real recién ocurre en quote_commit, y SOLO si el entregable es válido.',
    schema: z.object({}),
    method: 'POST',
    endpoint: '/quotes/reserve',
  },
  quote_commit: {
    description:
      'CORTAFUEGOS — Finaliza la cotización: el backend valida el entregable contra el presupuesto persistido en CERP y, solo si es válido, consume/cobra el crédito. Llamar al FINAL, OBLIGATORIAMENTE después de recalculate_budget (los totales se leen tal cual quedaron). Devuelve { committed, validation }. Si committed=true: el crédito se aplicó correctamente. Si committed=false: el entregable no pasó la validación (validation.message explica el motivo), NO se cobró nada, el crédito quedó liberado y el presupuesto parcial se descartó — comunicá al usuario usando validation.message y ofrecé reintentar.',
    schema: z.object({
      id: z.string().describe('quoteId devuelto por quote_reserve'),
      budgetId: z
        .string()
        .describe('ID del ConstructionBudget generado (el budgetId real de create_budget / get_budget_by_project)'),
    }),
    method: 'POST',
    endpoint: '/quotes/:id/commit',
  },
  quote_refund: {
    description:
      'CORTAFUEGOS — Libera una reserva sin cobrar (ej: el usuario cancela el flujo antes de terminar). Devuelve el crédito al pool; el presupuesto parcial queda guardado como borrador y se puede retomar despues. Usar SOLO si abandonás la cotización antes de quote_commit.',
    schema: z.object({
      id: z.string().describe('quoteId devuelto por quote_reserve'),
      reason: z
        .enum(['user_aborted', 'preflight_fail', 'error'])
        .optional()
        .describe('Motivo del refund (default user_aborted)'),
    }),
    method: 'POST',
    endpoint: '/quotes/:id/refund',
  },
  quote_register_files: {
    description: 'OBLIGATORIO al terminar de generar la cotización. Registra los paths locales del Excel y/o PDF generados, y opcionalmente metadata (projectName, totalAmount, lineItems).',
    schema: z.object({
      id: z.string().describe('quoteId devuelto por consume-free o purchase-extra'),
      excelPath: z.string().optional().describe('Ruta absoluta del .xlsx generado'),
      pdfPath: z.string().optional().describe('Ruta absoluta del .pdf/.docx generado'),
      metadata: z.object({
        projectName: z.string().optional(),
        totalAmount: z.number().optional(),
        lineItems: z.array(z.object({
          description: z.string(),
          quantity: z.number(),
          unitPrice: z.number(),
          subtotal: z.number(),
        })).optional(),
      }).optional(),
    }),
    method: 'POST',
    endpoint: '/quotes/:id/files',
  },
  // ============================================================
  // BUDGET ATTACHMENTS — Archivos adicionales del presupuesto
  // ============================================================
  get_budget_attachments: {
    description: 'Lista los archivos PDF adicionales adjuntos a un presupuesto. Llamar antes de generar el PDF de cotizacion para saber si hay PDFs que concatenar al final.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      budgetId: z.string().describe('ID del presupuesto'),
    }),
    method: 'GET',
    endpoint: '/projects/:projectId/attachments',
  },
  delete_budget_attachment: {
    description: 'Elimina un archivo PDF adjunto de un presupuesto.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      attachmentId: z.string().describe('ID del adjunto a eliminar'),
    }),
    method: 'DELETE',
    endpoint: '/projects/:projectId/attachments/:attachmentId',
  },

  quote_mark_synced: {
    description: 'Marca la cotización como sincronizada a un Budget del SaaS. Llamar después de crear el Budget en CERP via create_budget.',
    schema: z.object({
      id: z.string().describe('quoteId'),
      budgetId: z.string().describe('ID del Budget recién creado en CERP'),
    }),
    method: 'PATCH',
    endpoint: '/quotes/:id/sync',
  },
  list_quotes: {
    description: 'Lista las cotizaciones generadas por la empresa, paginado. Útil para mostrar historial.',
    schema: z.object({
      page: z.number().min(1).optional(),
      pageSize: z.number().min(1).max(100).optional(),
      source: z.enum(['trial_free', 'monthly_free', 'paid_extra']).optional(),
    }),
    method: 'GET',
    endpoint: '/quotes',
  },
}
