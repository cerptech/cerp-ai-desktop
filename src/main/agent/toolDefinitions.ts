import { z } from 'zod'

/**
 * Zod schemas for the 16 CERP MCP tools.
 * These mirror the JSON Schema definitions in brickflow-server/src/agents/constructia/tools.ts
 * but use Zod (required by the Agent SDK's tool() function).
 */

export const toolSchemas = {
  get_company_projects: {
    description:
      'Lista los proyectos de construccion de la empresa. Devuelve nombre, estado, fechas, costo proyectado y porcentaje de avance.',
    schema: z.object({
      status: z.enum(['budget', 'planning', 'execution', 'monitoring', 'closed']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/projects',
  },

  get_project_details: {
    description:
      'Obtiene el detalle completo de un proyecto: tareas, costos planificados vs reales, fechas y avance.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto (ObjectId de MongoDB)'),
      includeTasks: z.boolean().optional(),
    }),
    endpoint: '/projects/:projectId',
  },

  get_construction_sites: {
    description:
      'Lista las obras (frentes de trabajo) de la empresa. Nombre, estado, ubicacion, presupuesto y centro de costes.',
    schema: z.object({
      status: z.enum(['planning', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      projectId: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/construction-sites',
  },

  search_materials: {
    description:
      'Busca materiales o insumos en el inventario. Permite buscar por nombre, codigo o filtrar por stock bajo minimo.',
    schema: z.object({
      searchTerm: z.string().optional(),
      lowStock: z.boolean().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/items',
  },

  get_project_cashflow: {
    description:
      'Resumen del cashflow de un proyecto: costos presupuestados vs reales, ingresos proyectados, metricas financieras.',
    schema: z.object({
      projectId: z.string().describe('ID del proyecto'),
    }),
    endpoint: '/cashflow/:projectId',
  },

  get_construction_orders: {
    description:
      'Lista las ordenes de construccion. Nombre, estado, obra, cantidad planificada/ejecutada, costes y proveedor.',
    schema: z.object({
      status: z.enum(['planning', 'pending', 'execution', 'paused', 'completed', 'cancelled']).optional(),
      constructionSiteId: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/construction-orders',
  },

  get_construction_order_details: {
    description:
      'Detalle de una orden de construccion: materiales, recursos, centro de costos y avance.',
    schema: z.object({
      orderId: z.string().describe('ID de la orden de construccion'),
    }),
    endpoint: '/construction-orders/:orderId',
  },

  get_purchase_orders: {
    description:
      'Lista las ordenes de compra. Numero, proveedor, estado, monto total y fecha de entrega.',
    schema: z.object({
      status: z
        .enum(['draft', 'pending', 'approved', 'ordered', 'received', 'partial_received', 'cancelled'])
        .optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/purchases',
  },

  get_purchase_order_details: {
    description: 'Detalle de una orden de compra: items, proveedores, montos y estado de recepcion.',
    schema: z.object({
      purchaseOrderId: z.string().describe('ID de la orden de compra'),
    }),
    endpoint: '/purchases/:purchaseOrderId',
  },

  get_budgets: {
    description:
      'Presupuestos de construccion con resumen de capitulos, costos directos y totales de licitacion.',
    schema: z.object({
      projectId: z.string().optional(),
      status: z.enum(['draft', 'approved', 'locked']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/budgets',
  },

  get_expenses: {
    description: 'Lista los gastos registrados. Filtra por obra o rango de fechas.',
    schema: z.object({
      constructionSiteId: z.string().optional(),
      startDate: z.string().optional().describe('Fecha inicio ISO 8601'),
      endDate: z.string().optional().describe('Fecha fin ISO 8601'),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/finance/expenses',
  },

  get_warehouse_stock: {
    description: 'Inventario por almacen: materiales, stock actual, reservado y minimo.',
    schema: z.object({
      warehouseId: z.string().optional(),
      lowStock: z.boolean().optional(),
      limit: z.number().min(1).max(100).optional(),
    }),
    endpoint: '/warehouses/stock',
  },

  get_delivery_notes: {
    description: 'Lista los albaranes de entrega (notas de recepcion).',
    schema: z.object({
      purchaseOrderId: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/delivery-notes',
  },

  get_resources: {
    description:
      'Recursos productivos (mano de obra, herramientas, maquinaria). Disponibilidad, costos y asignaciones.',
    schema: z.object({
      type: z.enum(['labor', 'tools_machinery']).optional(),
      status: z.enum(['available', 'occupied', 'maintenance', 'retired']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/resources',
  },

  search_contacts: {
    description: 'Busca contactos (proveedores, clientes, subcontratistas) por nombre, email o tipo.',
    schema: z.object({
      searchTerm: z.string().optional(),
      type: z.enum(['individual', 'company']).optional(),
      limit: z.number().min(1).max(50).optional(),
    }),
    endpoint: '/contacts',
  },

  get_task_details: {
    description: 'Detalle de una tarea especifica: subtareas, centro de costos, estado.',
    schema: z.object({
      taskId: z.string().describe('ID de la tarea'),
    }),
    endpoint: '/tasks/:taskId',
  },
} as const
