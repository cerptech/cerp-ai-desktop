# Plan: Visibilidad de la actividad del subagente (CERP IA Desktop)

> Estudio del estado del SDK de Anthropic + plan para mostrar qué hace el subagente cuando el orquestador delega ("Delegando a agente").
> Fecha: 2026-06-01

## Problema

Cuando el orquestador delega a un subagente (tool `Agent`), la UI solo muestra el paso "Delegando a agente" y luego el resultado final. El usuario **no ve qué hace el subagente durante** (sus Bash/Read/MCP, su razonamiento).

## Causa raíz (confirmada en código)

Los eventos internos del subagente **SÍ llegan** en el stream del SDK: vienen como mensajes con `parent_tool_use_id` seteado (el `tool_use_id` del `Agent` que delegó). Pero el desktop los **descarta a propósito**:

`src/main/agent/agentManager.ts:388-391`
```ts
const parentToolId = (msgObj as any).parent_tool_use_id
if (parentToolId && (msgType === 'assistant' || msgType === 'tool_result' || msgType === 'user')) {
  continue // Don't forward subagent internals to UI
}
```

→ **No es limitación del SDK.** Los datos están; los tiramos. El fix base no requiere actualizar nada.

## Estudio: lo nuevo del SDK de Anthropic (junio 2026)

### Modelo
- **Claude Opus 4.8** (28-05-2026) es el flagship nuevo: ~4× menos probable que 4.7 de dejar pasar bugs en su propio código; SoTA en agentes de browser; ships con "Dynamic Workflows" (orquesta cientos de subagentes en paralelo).
- Lineup actual: Opus 4.8, Opus 4.7, **Sonnet 4.6**, Haiku 4.5.
- El desktop hoy **hardcodea** `claude-sonnet-4-6` en `src/main/ipc/handlers.ts:78` (no lee `CLAUDE_MODEL`).

### SDK `@anthropic-ai/claude-agent-sdk`
- Repo en `^0.2.80`. **Última: 0.3.159.**
- Features nuevas relevantes a este problema:
  | Feature | Desde | Para qué |
  |---|---|---|
  | `parent_tool_use_id` en mensajes/`SDKPartialAssistantMessage` | ya en 0.2.80 | identificar de qué delegación viene cada evento del subagente |
  | `getSubagentMessages()` / `listSubagents()` | 0.2.89 | leer el transcript completo del subagente de una sesión |
  | `includeHookEvents` | 0.2.89 | eventos de ciclo de vida de hooks |
  | `forwardSubagentText: true` | **0.2.119** | streamear los **deltas de texto/razonamiento** del subagente (por defecto se resumen) |
  | `Workflow` tool | 0.3.149 | orquestar decenas/cientos de agentes desde un script |
- Nuevos campos de `AgentDefinition` (útiles para nuestros 7 especialistas): `effort` (`low|medium|high|xhigh|max`), `background` (tarea no bloqueante), `maxTurns`, `permissionMode`, `skills`, `memory`, `mcpServers` inline.

### Conclusión del estudio
- **Fase 1 (mostrar las herramientas del subagente): NO requiere actualizar el SDK.** Solo dejar de descartar los mensajes con `parent_tool_use_id` y rutearlos como sub-pasos.
- **Fase 2 (mostrar el razonamiento del subagente en vivo + transcript on-demand): requiere bump a ≥0.2.119** (idealmente a la 0.3.x más reciente). Validar breaking changes 0.2→0.3.

## Plan de implementación

### Fase 1 — Sub-pasos del subagente en vivo (sin upgrade)

**Backend (`agentManager.ts`):**
1. Mantener un registro de delegaciones activas: cuando llega un `tool_use` con `name === 'Agent'`, guardar `{ toolUseId, agentName }` (ya se detecta el agentName en `mapMessage` líneas 631-638).
2. Reemplazar el `continue` de las líneas 388-391: para mensajes con `parent_tool_use_id`, mapear los bloques `tool_use`/`tool_result` internos a eventos nuevos **etiquetados con el padre**:
   - `subagent_tool_start { parentToolUseId, agentName, name, input }`
   - `subagent_tool_done { parentToolUseId, agentName, name, output }`
3. Manejar `Agent` con nombres `'Agent'` y `'Task'` (compat versiones, por la doc oficial).

**IPC/preload (`ipc/types.ts`, `channels.ts`, `preload`):** agregar los 2 tipos de evento al union `AgentStreamEvent`.

**Renderer (`ToolIndicator.tsx`, `useAgent.ts`, `toolUtils.ts`):**
4. Asociar los sub-pasos a su delegación por `parentToolUseId` y renderizarlos **anidados (indentados) dentro de la card "Delegando a {rol}"**.
5. Mientras corre: header "Delegando a Presupuestista · N pasos · trabajando…" + lista de sub-pasos con spinner/✓ (reusar el look de `ToolStep`).
6. Al terminar: colapsar a "Presupuestista · N pasos ✓" (expandible).

### Fase 2 — Razonamiento + transcript (con upgrade del SDK)

7. Bump `@anthropic-ai/claude-agent-sdk` a la 0.3.x más reciente. Probar regresiones del agente.
8. Activar `forwardSubagentText: true` en las opciones de `query()` → mostrar el texto/razonamiento del subagente en vivo dentro de su card.
9. Botón "Ver transcripción completa" que use `getSubagentMessages(agentId)` para expandir todo el hilo del subagente bajo demanda.

### Mejoras oportunistas (mismo o follow-up)
- Hacer el **modelo configurable** (hoy hardcodeado): orquestador en un modelo más fuerte (Opus 4.8) para mejor delegación; especialistas en Sonnet/Haiku. Tunear con `effort` por agente.
- Evaluar `background: true` para especialistas que pueden correr no-bloqueantes.

## Mockup visual

```
┌──────────────────────────────────────────────────────────┐
│ ⤷ Delegando a Presupuestista        · 3 pasos · trabajando…│  ← header delegación (vivo)
│   ├─ ⏳ Leyendo  Cómputo_y_Presupuesto.xlsx                │  ← sub-paso del subagente
│   ├─ ✓  Ejecutó  Bash: ls -la "/Downloads/…"   2m 41s      │
│   └─ ⏳ Analizando partidas…  (texto en vivo, Fase 2)      │
└──────────────────────────────────────────────────────────┘
        ↓ al terminar (colapsado, expandible)
┌──────────────────────────────────────────────────────────┐
│ ✓ Presupuestista · 7 pasos          1m 50s   [Ver detalle]│
└──────────────────────────────────────────────────────────┘
```

## Riesgos / notas
- Fase 1 es bajo riesgo (solo enrutar datos que ya existen). Cuidar el volumen de eventos en delegaciones largas (throttle/agrupar en el renderer).
- Fase 2: el bump 0.2→0.3 puede traer breaking changes; testear el flujo completo del agente (Plan Mode, AskUserQuestion, MCP) antes de mergear.
- Mantener compat `Agent`/`Task` en `block.name`.

## Archivos a tocar (Fase 1)
- `src/main/agent/agentManager.ts` (routing, líneas ~388-391 y ~605-696)
- `src/main/ipc/types.ts` (nuevos eventos)
- `src/main/ipc/channels.ts` / `src/preload/index.ts` + `index.d.ts` (si hace falta)
- `src/renderer/src/hooks/useAgent.ts` (acumular sub-pasos por parentToolUseId)
- `src/renderer/src/components/layout/ToolIndicator.tsx` + `src/renderer/src/utils/toolUtils.ts` (render anidado)
