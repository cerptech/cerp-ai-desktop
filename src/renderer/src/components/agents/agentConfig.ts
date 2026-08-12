import { Building2, Database, FileSpreadsheet, Box, Ruler, Hammer, BookOpen, FileText } from 'lucide-react'
import type { CustomAgent } from '../../../../preload/index'
import type { AgentIconType } from './AgentIcon'

export interface AgentInfo {
  name: string
  label: string
  description: string
  icon: AgentIconType
  shortDescription: string
  isCustom?: boolean
}

export const AGENTS: AgentInfo[] = [
  {
    name: 'orchestrator',
    label: 'CERP AI',
    description: 'Orquestador principal. Decide qué agente usar y coordina tareas complejas.',
    icon: Building2,
    shortDescription: 'Asistente general',
  },
  {
    name: 'cerp-data',
    label: 'CERP Data',
    description: 'Consulta proyectos, obras, cashflow, presupuestos, órdenes y materiales del ERP.',
    icon: Database,
    shortDescription: 'Datos del ERP',
  },
  {
    name: 'excel-analyst',
    label: 'Excel',
    description: 'Lee, analiza y crea archivos Excel/CSV. Presupuestos, mediciones, planillas.',
    icon: FileSpreadsheet,
    shortDescription: 'Archivos Excel/CSV',
  },
  {
    name: 'revit-bim',
    label: 'BIM / IFC',
    description: 'Archivos IFC, modelos BIM, Revit. Geometría, cantidades, visualización 3D.',
    icon: Box,
    shortDescription: 'Modelos BIM/IFC',
  },
  {
    name: 'autocad-agent',
    label: 'AutoCAD',
    description: 'Archivos DWG/DXF. Planos, capas, mediciones, scripts AutoLISP.',
    icon: Ruler,
    shortDescription: 'Planos AutoCAD',
  },
  {
    name: 'sketchup-agent',
    label: 'SketchUp',
    description: 'Modelos SketchUp. Componentes, materiales, exportación 3D.',
    icon: Hammer,
    shortDescription: 'Modelos SketchUp',
  },
  {
    name: 'architecture',
    label: 'Arquitectura',
    description: 'Documentación técnica. Memorias, pliegos, normativa, certificaciones.',
    icon: BookOpen,
    shortDescription: 'Documentos técnicos',
  },
  {
    name: 'report-generator',
    label: 'Reportes',
    description: 'PDFs profesionales, gráficos, presentaciones, reportes de obra.',
    icon: FileText,
    shortDescription: 'Generar reportes',
  },
]

export function mergeAgentConfigs(customAgents: CustomAgent[]): AgentInfo[] {
  const custom: AgentInfo[] = customAgents.map((a) => ({
    name: a.name,
    label: a.label,
    description: a.description,
    // Los agentes custom siguen siendo emoji libre elegido por el usuario
    // (CustomAgentModal) — no se fuerzan a un ícono lucide.
    icon: a.icon,
    shortDescription: a.description.substring(0, 40),
    isCustom: true,
  }))
  return [...AGENTS, ...custom]
}
