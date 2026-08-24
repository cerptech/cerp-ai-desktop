/**
 * toolUtils.ts
 *
 * Shared utilities for rendering tool-execution steps in the UI.
 * All functions are pure and free of side-effects.
 */

// ---------------------------------------------------------------------------
// truncateMiddle
// ---------------------------------------------------------------------------

/**
 * Truncates a string in the middle, preserving the start and the filename
 * (everything after the last path separator). Useful for long file paths.
 *
 * Example:
 *   truncateMiddle('C:\\Users\\zzeze\\OneDrive\\Escritorio\\CERP\\PRESUPUESTO.xlsx', 50)
 *   → 'C:\\Users\\zzeze\\…\\PRESUPUESTO.xlsx'
 */
export function truncateMiddle(str: string, maxLen = 55): string {
  if (str.length <= maxLen) return str

  // Extract filename (everything after the last / or \)
  const sepIdx = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'))
  const filename = sepIdx >= 0 ? str.slice(sepIdx + 1) : str
  const prefix = str.slice(0, Math.max(10, maxLen - filename.length - 4))

  // If even the filename alone is too long, just truncate the end
  if (filename.length >= maxLen - 5) {
    return str.slice(0, maxLen - 1) + '…'
  }

  return `${prefix}…\\${filename}`
}

// ---------------------------------------------------------------------------
// getToolHumanLabel
// ---------------------------------------------------------------------------

const KNOWN_TOOL_LABELS: Record<string, string> = {
  // SDK built-in tools
  ToolSearch: 'Cargando herramientas',
  Glob: 'Buscando archivos',
  Grep: 'Buscando texto',
  Read: 'Leyendo archivo',
  Write: 'Escribiendo archivo',
  Edit: 'Editando archivo',
  Bash: 'Ejecutando comando',
  WebFetch: 'Buscando en web',
  WebSearch: 'Buscando en web',
  // Agent delegation
  Agent: 'Delegando a agente',
  // MCP CERP tools (by suffix)
  get_company_projects: 'Consultando proyectos',
  get_project_details: 'Detalle de proyecto',
  get_construction_sites: 'Consultando obras',
  search_materials: 'Buscando materiales',
  get_project_cashflow: 'Consultando cashflow',
  get_construction_orders: 'Consultando ordenes de obra',
  get_purchase_orders: 'Consultando ordenes de compra',
  get_budgets: 'Consultando presupuestos',
  get_expenses: 'Consultando gastos',
  get_warehouse_stock: 'Consultando inventario',
  get_resources: 'Consultando recursos',
  search_contacts: 'Buscando contactos',
  create_project: 'Creando proyecto',
  update_project: 'Actualizando proyecto',
  create_task: 'Creando tarea',
  update_task: 'Actualizando tarea',
  add_budget_items_batch: 'Cargando items del presupuesto',
  create_budget_item: 'Creando item del presupuesto',
  update_budget_item: 'Actualizando item del presupuesto',
  create_construction_order: 'Creando orden de obra',
  create_purchase_order: 'Creando orden de compra',
  create_expense: 'Registrando gasto',
  create_material: 'Registrando material',
  update_warehouse_stock: 'Actualizando inventario',
  get_credit_balance: 'Consultando saldo de creditos',
}

/**
 * Converts a raw SDK tool name into a human-readable Spanish label.
 *
 * Priority:
 *  1. Exact match in KNOWN_TOOL_LABELS
 *  2. Strip mcp__ prefix (e.g. `mcp__cerp-data__create_project` → `create_project`) and match
 *  3. Smart camelCase / snake_case humanisation of the suffix
 */
export function getToolHumanLabel(name: string, agentName?: string): string {
  if (name === 'Agent' && agentName) {
    return `Trabajando con ${agentName}`
  }

  // Exact match
  if (KNOWN_TOOL_LABELS[name]) return KNOWN_TOOL_LABELS[name]

  // Strip mcp__ prefix (format: mcp__<server>__<tool_name>)
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/)
  if (mcpMatch) {
    const suffix = mcpMatch[1]
    if (KNOWN_TOOL_LABELS[suffix]) return KNOWN_TOOL_LABELS[suffix]
    // Auto-humanise the suffix
    return humaniseSuffix(suffix)
  }

  // Fallback: humanise as-is
  return humaniseSuffix(name)
}

function humaniseSuffix(s: string): string {
  // snake_case → "Title Case words"
  const words = s
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase())
  return words
}

// ---------------------------------------------------------------------------
// getVagueActivityLabel — "lenguaje de obra" (Ola 2)
// ---------------------------------------------------------------------------

/**
 * Mientras una tool corre, el usuario no necesita saber que se llamó
 * `get_budgets` con tal filtro — necesita saber, en una frase de obra, qué
 * está haciendo el agente. Esta función mapea grupos de tools técnicas a una
 * etiqueta vaga y sin parámetros; el detalle técnico (nombre real + input)
 * sigue disponible al expandir ("Ver detalles" en ToolIndicator).
 *
 * Deliberadamente vago: nunca interpola valores del input.
 */
const VAGUE_ACTIVITY_RULES: Array<{ test: RegExp; label: string }> = [
  { test: /budget|presupuesto/i, label: 'Consultando presupuestos…' },
  { test: /construction_site|construction_order|obra/i, label: 'Revisando la obra…' },
  { test: /material|warehouse|stock|inventario/i, label: 'Buscando materiales…' },
  { test: /^(read|write|edit)$/i, label: 'Leyendo el documento…' },
  { test: /^(glob|grep)$/i, label: 'Buscando archivos…' },
  { test: /project|task|tarea/i, label: 'Revisando el proyecto…' },
  { test: /cashflow|expense|gasto|purchase_order|orden.*compra/i, label: 'Revisando las finanzas…' },
  { test: /contact|contacto/i, label: 'Buscando contactos…' },
  { test: /^(websearch|webfetch)$/i, label: 'Buscando en internet…' },
  { test: /^bash$/i, label: 'Ejecutando un paso…' },
]

export function getVagueActivityLabel(toolName: string, agentName?: string): string {
  if (toolName === 'Agent' || toolName === 'Task') {
    return agentName ? `Trabajando con ${agentName}…` : 'Delegando…'
  }
  const baseName = toolName.replace(/^mcp__[^_]+__/, '')
  for (const rule of VAGUE_ACTIVITY_RULES) {
    if (rule.test.test(baseName)) return rule.label
  }
  return 'Trabajando…'
}

// ---------------------------------------------------------------------------
// formatToolInput
// ---------------------------------------------------------------------------

/**
 * Given a raw input string (usually JSON), return a short human-readable
 * description suitable for inline display next to the tool label.
 *
 * The `file_path` tooltip is returned separately so callers can attach it to
 * a `title` attribute for hover.
 */
export interface FormattedInput {
  /** Short display text — max ~60 chars */
  display: string
  /** Full value for the title/tooltip attribute, or undefined */
  tooltip?: string
}

export function formatToolInput(toolName: string, rawInput: string | undefined): FormattedInput | null {
  if (!rawInput) return null

  // Normalise tool name (strip mcp prefix)
  const baseName = toolName.replace(/^mcp__[^_]+__/, '')

  // Try to parse as JSON
  let parsed: Record<string, unknown> | null = null
  try {
    const candidate = JSON.parse(rawInput)
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>
    }
  } catch {
    // Not JSON — fall through to raw handling
  }

  if (parsed) {
    // --- ToolSearch ---
    if (baseName === 'ToolSearch') {
      const query = String(parsed.query ?? '')
      // "select:Glob,Read" → "Glob, Read"
      const selectMatch = query.match(/^select:(.+)$/)
      if (selectMatch) {
        return { display: selectMatch[1].replace(/,/g, ', ') }
      }
      return { display: truncateMiddle(query, 55) }
    }

    // --- Glob ---
    if (baseName === 'Glob') {
      const pattern = String(parsed.pattern ?? '')
      return { display: pattern }
    }

    // --- Grep ---
    if (baseName === 'Grep') {
      const pattern = String(parsed.pattern ?? '')
      return { display: truncateMiddle(pattern, 55) }
    }

    // --- Read ---
    if (baseName === 'Read') {
      const fp = String(parsed.file_path ?? '')
      const filename = fp.replace(/\\/g, '/').split('/').pop() ?? fp
      return { display: filename, tooltip: fp }
    }

    // --- Write / Edit ---
    if (baseName === 'Write' || baseName === 'Edit') {
      const fp = String(parsed.file_path ?? '')
      const filename = fp.replace(/\\/g, '/').split('/').pop() ?? fp
      return { display: filename, tooltip: fp }
    }

    // --- Bash ---
    if (baseName === 'Bash') {
      const cmd = String(parsed.command ?? '')
      return { display: truncateMiddle(cmd, 60) }
    }

    // --- WebFetch ---
    if (baseName === 'WebFetch') {
      const url = String(parsed.url ?? '')
      return { display: truncateMiddle(url, 55) }
    }

    // --- WebSearch ---
    if (baseName === 'WebSearch') {
      const q = String(parsed.query ?? '')
      return { display: truncateMiddle(q, 55) }
    }

    // Generic: show first string value found, truncated
    const firstStringEntry = Object.entries(parsed).find(([, v]) => typeof v === 'string')
    if (firstStringEntry) {
      return { display: truncateMiddle(String(firstStringEntry[1]), 60) }
    }
  }

  // Fallback: raw string, inline (no newlines), max 80 chars
  const inline = rawInput.replace(/\s+/g, ' ').trim()
  if (inline.length <= 80) return { display: inline }
  return { display: inline.slice(0, 79) + '…' }
}

// ---------------------------------------------------------------------------
// summarizeToolOutput
// ---------------------------------------------------------------------------

/**
 * Produces a short summary line from a tool's output string.
 * Returns null if no meaningful summary can be derived.
 */
export function summarizeToolOutput(toolName: string, output: string | undefined): string | null {
  if (!output) return null

  const baseName = toolName.replace(/^mcp__[^_]+__/, '')

  // --- Glob ---
  if (baseName === 'Glob') {
    // Output is typically a JSON array of paths or newline-separated list
    try {
      const parsed = JSON.parse(output)
      if (Array.isArray(parsed)) {
        const n = parsed.length
        return n === 0 ? 'Sin resultados' : `${n} archivo${n !== 1 ? 's' : ''} encontrado${n !== 1 ? 's' : ''}`
      }
    } catch {
      // Count lines
    }
    const lines = output.split('\n').filter(Boolean)
    if (lines.length > 0) {
      return `${lines.length} archivo${lines.length !== 1 ? 's' : ''} encontrado${lines.length !== 1 ? 's' : ''}`
    }
    return null
  }

  // --- Grep ---
  if (baseName === 'Grep') {
    const lines = output.split('\n').filter(Boolean)
    if (lines.length > 0) {
      return `${lines.length} coincidencia${lines.length !== 1 ? 's' : ''}`
    }
    return 'Sin resultados'
  }

  // --- Read ---
  if (baseName === 'Read') {
    const lines = output.split('\n').length
    const kb = Math.round(output.length / 1024)
    if (kb > 0) return `${lines} líneas · ${kb} KB`
    return `${lines} líneas`
  }

  // --- Write / Edit ---
  if (baseName === 'Write' || baseName === 'Edit') {
    return 'Archivo guardado'
  }

  // --- Bash ---
  if (baseName === 'Bash') {
    const firstLine = output.split('\n')[0].trim()
    if (firstLine) return truncateMiddle(firstLine, 80)
    return null
  }

  // --- MCP CERP tools: look for id/created/count in JSON response ---
  try {
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      if (parsed.id) return `ID: ${parsed.id}`
      if (parsed.created) return 'Creado'
      if (parsed.updated) return 'Actualizado'
      if (Array.isArray(parsed.data)) return `${parsed.data.length} resultado${parsed.data.length !== 1 ? 's' : ''}`
      if (typeof parsed.count === 'number') return `${parsed.count} resultado${parsed.count !== 1 ? 's' : ''}`
      if (parsed.success === true) return 'OK'
    }
  } catch {
    // Not JSON
  }

  return null
}
