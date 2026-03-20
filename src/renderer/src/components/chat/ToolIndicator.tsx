import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

const TOOL_LABELS: Record<string, string> = {
  get_company_projects: 'Consultando proyectos...',
  get_project_details: 'Obteniendo detalle del proyecto...',
  get_construction_sites: 'Consultando obras...',
  search_materials: 'Buscando materiales...',
  get_project_cashflow: 'Analizando cashflow...',
  get_construction_orders: 'Consultando ordenes de construccion...',
  get_construction_order_details: 'Obteniendo detalle de orden...',
  get_purchase_orders: 'Consultando ordenes de compra...',
  get_purchase_order_details: 'Obteniendo detalle de compra...',
  get_budgets: 'Consultando presupuestos...',
  get_expenses: 'Consultando gastos...',
  get_warehouse_stock: 'Verificando inventario...',
  get_delivery_notes: 'Consultando albaranes...',
  get_resources: 'Consultando recursos...',
  search_contacts: 'Buscando contactos...',
  get_task_details: 'Obteniendo detalle de tarea...',
}

interface ToolIndicatorProps {
  toolName: string
}

export function ToolIndicator({ toolName }: ToolIndicatorProps) {
  const label = TOOL_LABELS[toolName] || `Ejecutando ${toolName}...`

  return (
    <div className="flex items-center gap-2 px-4 py-2 mb-4">
      <LoadingSpinner size="sm" />
      <span className="text-xs text-slate-500 italic">{label}</span>
    </div>
  )
}
