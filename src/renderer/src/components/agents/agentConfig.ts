import type { CustomAgent } from '../../../../preload/index'

export interface AgentInfo {
  name: string
  label: string
  description: string
  icon: string
  shortDescription: string
  isCustom?: boolean
}

export const AGENTS: AgentInfo[] = [
  {
    name: 'orchestrator',
    label: 'CERP AI',
    description: 'Orquestador principal. Decide que agente usar y coordina tareas complejas.',
    icon: '\u{1F3D7}',
    shortDescription: 'Asistente general',
  },
  {
    name: 'cerp-data',
    label: 'CERP Data',
    description: 'Consulta proyectos, obras, cashflow, presupuestos, ordenes y materiales del ERP.',
    icon: '\u{1F4CA}',
    shortDescription: 'Datos del ERP',
  },
  {
    name: 'excel-analyst',
    label: 'Excel',
    description: 'Lee, analiza y crea archivos Excel/CSV. Presupuestos, mediciones, planillas.',
    icon: '\u{1F4C8}',
    shortDescription: 'Archivos Excel/CSV',
  },
  {
    name: 'revit-bim',
    label: 'BIM / IFC',
    description: 'Archivos IFC, modelos BIM, Revit. Geometria, cantidades, visualizacion 3D.',
    icon: '\u{1F3E0}',
    shortDescription: 'Modelos BIM/IFC',
  },
  {
    name: 'autocad-agent',
    label: 'AutoCAD',
    description: 'Archivos DWG/DXF. Planos, capas, mediciones, scripts AutoLISP.',
    icon: '\u{1F4D0}',
    shortDescription: 'Planos AutoCAD',
  },
  {
    name: 'sketchup-agent',
    label: 'SketchUp',
    description: 'Modelos SketchUp. Componentes, materiales, exportacion 3D.',
    icon: '\u{1F528}',
    shortDescription: 'Modelos SketchUp',
  },
  {
    name: 'architecture',
    label: 'Arquitectura',
    description: 'Documentacion tecnica. Memorias, pliegos, normativa, certificaciones.',
    icon: '\u{1F4D1}',
    shortDescription: 'Documentos tecnicos',
  },
  {
    name: 'report-generator',
    label: 'Reportes',
    description: 'PDFs profesionales, graficos, presentaciones, reportes de obra.',
    icon: '\u{1F4C4}',
    shortDescription: 'Generar reportes',
  },
]

export function mergeAgentConfigs(customAgents: CustomAgent[]): AgentInfo[] {
  const custom: AgentInfo[] = customAgents.map((a) => ({
    name: a.name,
    label: a.label,
    description: a.description,
    icon: a.icon,
    shortDescription: a.description.substring(0, 40),
    isCustom: true,
  }))
  return [...AGENTS, ...custom]
}
