import { useState } from 'react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import type { ToolExecution } from '@/hooks/useAgent'

const TOOL_ICONS: Record<string, string> = {
  Bash: 'terminal',
  Read: 'file',
  Write: 'pencil',
  Edit: 'pencil',
  Glob: 'search',
  Grep: 'search',
  Agent: 'agent',
  // MCP CERP tools
  get_company_projects: 'database',
  get_project_details: 'database',
  get_construction_sites: 'database',
  search_materials: 'database',
  get_project_cashflow: 'database',
  get_construction_orders: 'database',
  get_purchase_orders: 'database',
  get_budgets: 'database',
  get_expenses: 'database',
  get_warehouse_stock: 'database',
  get_resources: 'database',
  search_contacts: 'database',
}

function getToolIcon(name: string): string {
  const key = name.replace('mcp__cerp__', '')
  const iconType = TOOL_ICONS[key] || TOOL_ICONS[name] || 'gear'
  const icons: Record<string, string> = {
    terminal: '\u{25B6}',
    file: '\u{1F4C4}',
    pencil: '\u{270F}',
    search: '\u{1F50D}',
    database: '\u{1F4CA}',
    agent: '\u{1F916}',
    gear: '\u{2699}',
  }
  return icons[iconType] || icons.gear
}

function getToolLabel(name: string): string {
  const clean = name.replace('mcp__cerp__', '')
  const labels: Record<string, string> = {
    Bash: 'Ejecutando comando',
    Read: 'Leyendo archivo',
    Write: 'Escribiendo archivo',
    Edit: 'Editando archivo',
    Glob: 'Buscando archivos',
    Grep: 'Buscando en contenido',
    Agent: 'Delegando a agente',
    get_company_projects: 'Consultando proyectos CERP',
    get_project_details: 'Detalle de proyecto CERP',
    get_construction_sites: 'Consultando obras CERP',
    search_materials: 'Buscando materiales CERP',
    get_project_cashflow: 'Cashflow CERP',
    get_construction_orders: 'Ordenes de construccion CERP',
    get_purchase_orders: 'Ordenes de compra CERP',
    get_budgets: 'Presupuestos CERP',
    get_expenses: 'Gastos CERP',
    get_warehouse_stock: 'Inventario CERP',
    get_resources: 'Recursos CERP',
    search_contacts: 'Contactos CERP',
  }
  return labels[clean] || labels[name] || clean.replace(/_/g, ' ')
}

interface ToolExecutionsProps {
  tools: ToolExecution[]
}

export function ToolExecutions({ tools }: ToolExecutionsProps) {
  const [expanded, setExpanded] = useState(false)

  if (!tools.length) return null

  const running = tools.filter((t) => t.status === 'running')
  const done = tools.filter((t) => t.status === 'done')

  return (
    <div className="mb-3 text-xs">
      {/* Active tools */}
      {running.map((tool, i) => (
        <div key={`r-${i}`} className="flex items-start gap-2 py-1.5 text-brand-orange">
          <LoadingSpinner size="sm" />
          <div className="min-w-0">
            <span className="font-medium">{getToolLabel(tool.name)}</span>
            {tool.input && (
              <div className="mt-0.5 font-mono text-[11px] text-slate-500 bg-slate-50 rounded px-2 py-1 truncate max-w-[400px]">
                {tool.input}
              </div>
            )}
          </div>
        </div>
      ))}

      {/* Completed tools - collapsible */}
      {done.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 py-1 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <span className={`text-[10px] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>&#9654;</span>
            <span className="text-emerald-500 text-[10px]">&#10003;</span>
            <span>{done.length} paso{done.length > 1 ? 's' : ''} completado{done.length > 1 ? 's' : ''}</span>
          </button>

          {expanded && (
            <div className="ml-4 mt-1 border-l border-slate-200 pl-3 space-y-1.5">
              {done.map((tool, i) => (
                <ToolStep key={i} tool={tool} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolStep({ tool }: { tool: ToolExecution }) {
  const [showOutput, setShowOutput] = useState(false)

  return (
    <div>
      <button
        onClick={() => tool.output && setShowOutput(!showOutput)}
        className={`flex items-start gap-2 text-left ${tool.output ? 'hover:text-slate-700 cursor-pointer' : 'cursor-default'} text-slate-500 transition-colors`}
      >
        <span className="shrink-0 mt-0.5">{getToolIcon(tool.name)}</span>
        <div className="min-w-0">
          <span className="font-medium text-slate-600">{getToolLabel(tool.name)}</span>
          {tool.input && (
            <span className="ml-1.5 font-mono text-slate-400 truncate">{tool.input.substring(0, 80)}</span>
          )}
        </div>
      </button>
      {showOutput && tool.output && (
        <pre className="mt-1 ml-6 p-2 bg-slate-900 text-slate-300 rounded-md text-[10px] font-mono overflow-x-auto max-h-40 overflow-y-auto leading-relaxed">
          {tool.output}
        </pre>
      )}
    </div>
  )
}
