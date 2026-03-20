export interface QuickAction {
  label: string
  prompt: string
  icon: string
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'Estado de mis proyectos',
    prompt: 'Dame un resumen del estado de todos mis proyectos activos',
    icon: 'clipboard',
  },
  {
    label: 'Materiales con stock bajo',
    prompt: 'Que materiales tengo con stock por debajo del minimo?',
    icon: 'alert',
  },
  {
    label: 'Pedidos pendientes',
    prompt: 'Muestrame las ordenes de compra pendientes de aprobacion',
    icon: 'cart',
  },
  {
    label: 'Cashflow de proyecto',
    prompt: 'Cual es el estado financiero de mi proyecto principal? Muestrame el cashflow',
    icon: 'chart',
  },
  {
    label: 'Recursos disponibles',
    prompt: 'Que recursos (mano de obra y maquinaria) tengo disponibles ahora?',
    icon: 'users',
  },
  {
    label: 'Buscar proveedor',
    prompt: 'Muestrame la lista de proveedores activos de la empresa',
    icon: 'search',
  },
]
