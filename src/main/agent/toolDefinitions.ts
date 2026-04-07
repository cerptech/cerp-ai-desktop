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
}

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
    description: 'Crea un nuevo proyecto de construccion. Para presupuestos/licitaciones usar status "budget".',
    schema: z.object({
      name: z.string().describe('Nombre del proyecto'),
      description: z.string().optional(),
      status: z.enum(['budget', 'planning', 'execution', 'paused', 'completed', 'cancelled']).optional().describe('Default: budget para licitaciones'),
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
    description: 'Presupuestos de construccion con capitulos, costos directos y totales.',
    schema: z.object({
      projectId: z.string().optional(),
      status: z.enum(['draft', 'approved', 'locked']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    method: 'GET',
    endpoint: '/budgets',
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
    description: 'Agrega un capitulo (agrupacion) al presupuesto.',
    schema: z.object({
      budgetId: z.string().describe('ID del presupuesto'),
      name: z.string().describe('Nombre del capitulo'),
      description: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/budgets/:budgetId/chapters',
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
    description: 'Crea una nueva tarea dentro de un proyecto.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
      name: z.string().describe('Nombre de la tarea'),
      description: z.string().optional(),
      parentTaskId: z.string().optional().describe('ID de tarea padre (para subtareas)'),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
    method: 'POST',
    endpoint: '/projects/:projectId/tasks',
  },
  update_task: {
    description: 'Actualiza una tarea. NOTA: si tiene subtareas, el progreso se calcula automaticamente.',
    schema: z.object({
      taskId: z.string().describe('ID de la tarea'),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
      progress: z.number().min(0).max(100).optional(),
    }),
    method: 'PUT',
    endpoint: '/tasks/:taskId',
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
  create_material: {
    description: 'Crea un nuevo material/item en el inventario. IMPORTANTE: siempre enviar un code unico para evitar colisiones (ej: "EXC-ZANJAS-001", "HORM-H25-002").',
    schema: z.object({
      name: z.string().describe('Nombre del material'),
      code: z.string().optional().describe('Codigo unico del material (ej: "EXC-ZANJAS-001"). Si no se envia, se autogenera del nombre y puede colisionar. SIEMPRE enviarlo.'),
      unit: z.string().optional().describe('Unidad (kg, m, m2, m3, u, gl, etc.)'),
      description: z.string().optional().describe('Descripcion detallada del material'),
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
}
