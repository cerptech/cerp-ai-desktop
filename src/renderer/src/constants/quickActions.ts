export interface QuickAction {
  label: string
  prompt: string
  icon: string
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'Crear cotización de obra',
    prompt: 'Quiero crear un presupuesto/cotización de obra. Analiza los archivos de mi carpeta de trabajo y genera el presupuesto en CERP.',
    icon: 'document',
  },
  {
    label: 'Analizar archivos de licitación',
    prompt: 'Analiza los archivos de mi carpeta de trabajo. Identifica capítulos, partidas, cantidades y precios. Muestra un resumen estructurado.',
    icon: 'search',
  },
  {
    label: 'Estado de mis proyectos',
    prompt: 'Dame un resumen del estado de todos mis proyectos activos',
    icon: 'clipboard',
  },
  {
    label: 'Cashflow de proyecto',
    prompt: '¿Cuál es el estado financiero de mi proyecto principal? Muéstrame el cashflow',
    icon: 'chart',
  },
  {
    label: 'Pedidos pendientes',
    prompt: 'Muéstrame las órdenes de compra pendientes de aprobación',
    icon: 'cart',
  },
  {
    label: 'Materiales con stock bajo',
    prompt: '¿Qué materiales tengo con stock por debajo del mínimo?',
    icon: 'alert',
  },
]
