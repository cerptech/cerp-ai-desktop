export interface QuickAction {
  label: string
  prompt: string
  icon: string
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'Crear cotizacion de obra',
    prompt: 'Quiero crear un presupuesto/cotizacion de obra. Analiza los archivos de mi carpeta de trabajo y genera el presupuesto en CERP.',
    icon: 'document',
  },
  {
    label: 'Analizar archivos de licitacion',
    prompt: 'Analiza los archivos de mi carpeta de trabajo. Identifica capitulos, partidas, cantidades y precios. Muestra un resumen estructurado.',
    icon: 'search',
  },
  {
    label: 'Estado de mis proyectos',
    prompt: 'Dame un resumen del estado de todos mis proyectos activos',
    icon: 'clipboard',
  },
  {
    label: 'Cashflow de proyecto',
    prompt: 'Cual es el estado financiero de mi proyecto principal? Muestrame el cashflow',
    icon: 'chart',
  },
  {
    label: 'Pedidos pendientes',
    prompt: 'Muestrame las ordenes de compra pendientes de aprobacion',
    icon: 'cart',
  },
  {
    label: 'Materiales con stock bajo',
    prompt: 'Que materiales tengo con stock por debajo del minimo?',
    icon: 'alert',
  },
]
