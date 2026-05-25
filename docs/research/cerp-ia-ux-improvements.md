# CERP IA Desktop — Investigacion UX e Inventario de Mejoras

**Fecha:** Mayo 2026
**Version analizada:** 1.0.10
**Branch:** `docs/cerp-ia-ux-research`
**Autor:** Investigacion automatica (agente CERP AI)

---

## Resumen ejecutivo

CERP IA Desktop tiene una base de UX solida: loader animado, visibilidad de tool calls, streaming de texto, panel de conversaciones con busqueda, drag-and-drop de archivos, y un equipo de subagentes con etiquetas animadas en la toolbar. La app es funcionalmente completa para el flujo de cotizacion pero le falta una capa de confianza y control que las mejores apps de agentes IA (incluyendo Claude Desktop) ya ofrecen en 2026.

Las cinco mejoras de mayor impacto, en orden de prioridad:

1. **Plan Mode** — permitir al agente planificar antes de ejecutar, con revision del usuario
2. **AskUserQuestion nativo** — preguntas de clarificacion estructuradas con opciones (ya soportado por el SDK)
3. **Streaming visible de tool calls individuales** — activar `showThoughts` por default
4. **Confirmacion de acciones destructivas via `canUseTool`** — UI de aprobacion por herramienta
5. **Token/costo en tiempo real** — mostrar el gasto acumulado mientras el agente trabaja

---

## 1. Estado actual de la UX

### 1.1 Que tiene CERP IA hoy

**Layout**
- Sidebar de conversaciones (w-52) collapsible a w-12
- Toolbar superior con etiquetas de subagentes (CERP AI, CERP Data, Excel, BIM/IFC, AutoCAD, SketchUp, Arquitectura, Reportes) que se iluminan en naranja cuando estan activos y muestran un tick verde al terminar
- Area de chat central con burbujas (usuario: naranja, asistente: blanco con borde)
- Barra de input abajo con textarea auto-expandible, boton de carpeta, boton Enviar / Detener (Esc)

**Estado de procesamiento**
- `ThinkingLoader` con tres puntos rebotando en naranja y texto rotante (mas de 50 verbos en espanol: "Analizando...", "Calculando...", "Proyectando...", etc.)
- Cuando un subagente esta activo, muestra el label especifico: "Consultando datos de CERP", "Analizando archivos Excel", etc.
- Boton "Detener" y "Ver paso a paso" dentro del loader

**Visibilidad de herramientas**
- `ToolIndicator` / `ToolExecutions`: herramientas activas se muestran en naranja con spinner y contador de tiempo transcurrido; herramientas completadas se colapsan en un boton "N pasos completados" expandible
- Cada herramienta completada muestra icono, label en espanol, duracion, input truncado, y output expandible en bloque de codigo
- Toggle global "Ver ejecuciones" / "Ocultar ejecuciones" en el footer del chat

**Conversation management**
- Panel con listado, busqueda por titulo, fecha relativa, contador de mensajes, icono del agente
- Delete on hover
- Titulo auto-generado desde los primeros 50 caracteres del primer mensaje
- Sincronia con MongoDB via cerp-server

**Otras capacidades**
- Drag-and-drop de archivos al chat (inyecta paths en el textarea)
- Quick actions en pantalla vacia (acciones rapidas para cotizacion)
- Prompt suggestions post-respuesta (generadas por el SDK)
- Agentes y contextos personalizados (CRUD completo via modales)
- Contextos activables que inyectan instrucciones extra al system prompt
- Abort por Esc global
- Fallback timer de 30s para resetear isStreaming si el stream se cuelga
- Version display (v1.0.10)

### 1.2 Gaps identificados en el codigo

**Problema confirmado: el loader no siempre aparece al instante.**
En `ChatContainer.tsx` linea 258-274, el `ThinkingLoader` standalone solo se renderiza cuando `noAssistantYet || assistantHasContent`. Si el backend ya creo un mensaje de asistente pero sin contenido todavia, el indicador puede no aparecer. La condicion es correcta en la mayoria de casos pero hay una ventana de hasta ~300ms donde el usuario puede ver un area vacia.

**`showThoughts` esta apagado por default.**
La variable `showThoughts` arranca en `false` (ChatContainer linea 33). El usuario tiene que hacer click en "Ver ejecuciones" para ver los tool calls. Esto significa que por default el agente trabaja en silencio — solo se ven los puntos rebotando y el verb. El usuario avanzado que quiere trazabilidad tiene que descubrirlo.

**No hay Plan Mode implementado.**
El `agentManager.ts` usa `permissionMode: 'bypassPermissions'` fijo (linea 264). No hay flujo de planificacion ni modo de lectura previa. El agente pasa directo a ejecucion.

**No hay `canUseTool` callback.**
El SDK soporta pausar la ejecucion cuando el agente quiere usar una herramienta destructiva y esperar la decision del usuario. No esta implementado. El `permissionMode: 'bypassPermissions'` saltea todo control.

**No hay `AskUserQuestion` integrado en la UI.**
El SDK soporta que el agente genere preguntas con opciones y espere la respuesta del usuario via `canUseTool`. No esta implementado en el renderer — si el agente llama `AskUserQuestion`, la respuesta se gestiona solo en texto libre, no como un widget de opciones.

**El costo acumulado solo se loguea en consola.**
En `agentManager.ts` linea 597, el costo total se loguea con `logger.info('[USAGE]...')` pero no se envia al renderer. El usuario no ve cuanto le esta costando la sesion actual.

**La toolbar de subagentes no resetea el estado "done" entre conversaciones.**
Cuando el usuario crea una nueva conversacion, `setDoneAgents([])` si se llama pero el estado visual de los tags puede quedar en verde unos frames.

---

## 2. Comparativa con Claude Desktop y apps de agentes lideres en 2026

### 2.1 Claude Desktop (oficial de Anthropic)

Segun la documentacion y reviews de 2026, Claude Desktop ofrece:

- **Sidebar de sesiones con multi-session**: visualizacion de como se interconectan sesiones distintas
- **Split view**: multiples paneles abiertos en simultaneo para gestionar tareas paralelas
- **Markdown plan view**: sidebar expandible/colapsable con el plan en markdown, visible junto al chat activo
- **File structure visibility**: acceso directo a la estructura de archivos del proyecto desde la UI
- **Drag-and-drop de layout**: terminal, preview, diff viewer y chat se pueden reorganizar en grilla
- **Visual diff review**: muestra los cambios de archivos con diff antes de confirmar
- **App preview integrado**: renderiza la app que el agente esta construyendo
- **PR monitoring**: sigue pull requests abiertos

Para CERP IA Desktop, los patrones mas relevantes son:
- El **markdown plan view** (Plan Mode)
- La **visibilidad del diff / preview antes de ejecutar** (confirmacion de acciones)
- El layout con **panel de detalle separado del chat**

### 2.2 Patrones UX de referencia (investigacion 2025-2026)

**1. Plan-and-Execute (fuselabcreative.com, hatchworks.com)**
- Lista vertical de pasos a la izquierda del chat
- Cada paso muestra descripcion en una linea antes de ejecutarse
- El usuario puede modificar o eliminar pasos antes de que corran
- Patron critico para casos de uso de obra: antes de crear 50 partidas, el usuario ve el resumen y confirma

**2. Visibilidad de tool calls en tiempo real**
- Las mejores apps muestran que sistema externo se llamo, que devolvio, y cuanto tardo
- "Silence while the agent works is the fastest path to user anxiety" (fuselabcreative.com)
- CERP IA tiene esto implementado pero desactivado por default

**3. Indicadores de confianza (confidence signaling)**
- Binario: alta confianza = avanza, baja confianza = pausa para verificacion
- Para acciones destructivas (crear proyecto, aprobar presupuesto): pausa automatica

**4. Activity panel separado del chat (fuselabcreative.com)**
- Panel que muestra "que se hizo, que esta corriendo, que esta bloqueado, que viene despues"
- Diferente del historial de mensajes — es un log de acciones del agente

**5. Structured error recovery**
- Tres partes: que paso, por que, que probar a continuacion
- No solo un boton "Reintentar" generico

**6. Progressive delegation**
- Empezar con confirmacion en cada accion, expandir autonomia gradualmente segun el usuario aprueba acciones repetidas
- El SDK soporta `updatedPermissions` con destino `localSettings` para recordar aprobaciones

---

## 3. Lista priorizada de mejoras

---

### PRIORIDAD ALTA

---

#### MEJORA 1: Plan Mode — "Revisar antes de ejecutar"

**Que es:**
Modo opcional activable desde la UI donde el agente analiza los archivos y propone un plan (lista de acciones) antes de ejecutar nada. El usuario revisa el plan y lo aprueba o modifica. Solo entonces el agente ejecuta.

Se implementa con `permissionMode: 'plan'` del Claude Agent SDK. En plan mode, solo corren herramientas de lectura. El agente usa `AskUserQuestion` para clarificar requisitos antes de proponer el plan.

**Por que importa:**
El caso de uso principal de CERP IA es crear presupuestos completos — una operacion que puede crear decenas de registros en el ERP (proyecto, presupuesto, capitulos, 50+ partidas, materiales, costos indirectos). Si el agente se equivoca en el mapeo de columnas o en los precios, el usuario tiene que borrar todo manualmente. Ver el plan antes de ejecutar reduce drasticamente el riesgo de errores costosos.

Ya existe logica de confirmacion en el system prompt (checkpoints obligatorios antes de `add_budget_items_batch`) pero eso depende de que el agente siga las instrucciones. Plan Mode lo garantiza a nivel infraestructura.

**Esfuerzo estimado:** Medio (3-5 dias)

**Implementacion:**

1. Agregar un toggle "Modo revision" en la UI (un icono en la toolbar o un toggle en el input area)
2. En `agentManager.ts`, cuando el modo revision esta activo, pasar `permissionMode: 'plan'` en las options
3. En el mismo archivo, implementar el `canUseTool` callback para cuando el agente pide hacer `AskUserQuestion` (devolver las respuestas del usuario via IPC)
4. En el renderer, detectar cuando el agente termino de planificar (resultado del turno con plan mode) y mostrar un panel de "Plan de acciones" con boton "Aprobar y ejecutar"
5. Al aprobar, cambiar `permissionMode` a `bypassPermissions` (o `acceptEdits`) via `setPermissionMode()` dinamico (soportado por el SDK)

**Archivos afectados:**
- `src/main/agent/agentManager.ts` — opciones del query, `canUseTool` callback
- `src/renderer/src/components/chat/ChatContainer.tsx` — toggle UI, panel de plan
- `src/main/ipc/` — nuevo evento IPC para respuestas de `AskUserQuestion`
- `src/renderer/src/hooks/useAgent.ts` — nuevo event type `ask_user_question`

**Referencia SDK:**
```typescript
// Iniciar en plan mode
permissionMode: 'plan'

// Cambiar a ejecucion cuando el usuario aprueba
await activeQuery.setPermissionMode('bypassPermissions')
```

---

#### MEJORA 2: AskUserQuestion — Preguntas estructuradas con opciones

**Que es:**
Cuando el agente necesita aclaraciones (que tipo de IVA usar, si incluir gastos generales, cual es el cliente del proyecto), en lugar de pedir la informacion en texto libre en el chat, muestra un widget de opciones interactivo: lista de preguntas con botones/checkboxes. El usuario selecciona y el agente continua con contexto claro.

El Claude Agent SDK ya soporta `AskUserQuestion` con hasta 4 preguntas de 2-4 opciones cada una, incluyendo `multiSelect`. Solo falta la UI en el renderer y el IPC para transportar las respuestas.

**Por que importa:**
Actualmente cuando el agente necesita aclaracion, las pide en texto libre en el chat. El usuario tiene que tipear la respuesta, el agente interpreta, y a veces malinterpreta. Para un presupuestista que necesita confirmar 3-4 parametros antes de procesar 200 partidas, un widget de opciones es mucho mas rapido y menos propenso a errores de interpretacion.

El system prompt de CERP IA ya menciona varios casos donde se hacen preguntas (costos faltantes, tipo de recursos, confirmation masiva). AskUserQuestion los convierte en flujos estructurados.

**Esfuerzo estimado:** Medio (2-4 dias)

**Implementacion:**

1. En `agentManager.ts`, agregar `canUseTool` callback. Cuando `toolName === 'AskUserQuestion'`, enviar las preguntas al renderer via IPC y esperar la respuesta (Promise que se resuelve cuando el usuario responde)
2. Nuevo evento IPC: `AGENT_ASK_USER` (main → renderer) y `AGENT_USER_ANSWER` (renderer → main)
3. En `useAgent.ts`, manejar el nuevo evento y exponer `pendingQuestion` + `answerQuestion(answers)`
4. Nuevo componente `AskUserQuestionWidget.tsx` en `components/chat/` — tarjeta con titulo de pregunta, botones de opcion, soporte multi-select, boton "Responder"
5. En `ChatContainer.tsx`, renderizar el widget cuando `pendingQuestion !== null`, bloqueando el textarea

**Archivos afectados:**
- `src/main/agent/agentManager.ts`
- `src/main/ipc/channels.ts` — nuevos channels
- `src/renderer/src/hooks/useAgent.ts`
- `src/renderer/src/components/chat/` — nuevo componente
- `src/renderer/src/components/chat/ChatContainer.tsx`

---

### PRIORIDAD ALTA / RAPIDA

---

#### MEJORA 3: Activar tool calls por default ("Ver ejecuciones" ON por default)

**Que es:**
Cambiar el valor inicial de `showThoughts` de `false` a `true`. En lugar de mostrar solo los puntos rebotando, mostrar los tool calls en tiempo real desde el primer uso.

**Por que importa:**
El usuario objetivo es un presupuestista o jefe de obra que le acaba de pasar archivos confidenciales de licitacion al agente. Ver que el agente esta leyendo sus archivos (no "hacer magia") construye confianza. La investigacion UX de 2025-2026 es unanime: "observability into agent steps builds user trust" y "silence while the agent works is the fastest path to user anxiety".

El codigo ya existe y funciona. Solo es un cambio de valor por default.

**Esfuerzo estimado:** Bajo (30 minutos)

**Implementacion:**

En `ChatContainer.tsx` linea 33:
```typescript
// Antes
const [showThoughts, setShowThoughts] = useState(false)

// Despues
const [showThoughts, setShowThoughts] = useState(true)
```

Cambiar el label del toggle de "Ver ejecuciones" a "Ocultar detalle" para que sea consistente con el nuevo default.

**Archivos afectados:**
- `src/renderer/src/components/chat/ChatContainer.tsx`

---

#### MEJORA 4: Indicador de costo acumulado en tiempo real

**Que es:**
Mostrar el costo en USD de la sesion actual mientras el agente trabaja — un numero pequeno (por ejemplo, "$0.043") en el footer del chat que se actualiza con cada evento `done` (fin de turno). Al cerrar la sesion, mostrar el total acumulado.

**Por que importa:**
CERP IA cobra cotizaciones ($19.99 por cotizacion). El usuario tiene una expectativa de que el servicio tiene un costo visible. Ademas, las sesiones largas con archivos grandes pueden acumular costos de API en segundos. El agente ya loguea `cost=$X` en consola; solo falta mostrarlo en la UI.

Esto tambien es diferenciador competitivo: Claude Desktop no muestra el costo por sesion. CERP IA si.

**Esfuerzo estimado:** Bajo (1-2 horas)

**Implementacion:**

1. En `agentManager.ts`, el evento `done` ya incluye `cost`. Asegurarse de que se envie al renderer: `sendEvent({ type: 'done', cost, turns })` — ya esta en la linea 598.
2. En `useAgent.ts`, acumular el costo por sesion: `sessionCost += event.cost || 0` en el handler del evento `done`.
3. Exponer `sessionCost` desde el hook.
4. En `ChatContainer.tsx` footer, mostrar `$${sessionCost.toFixed(4)}` junto a la version cuando `sessionCost > 0`.

**Archivos afectados:**
- `src/renderer/src/hooks/useAgent.ts`
- `src/renderer/src/components/chat/ChatContainer.tsx`

---

#### MEJORA 5: Confirmacion de acciones destructivas via `canUseTool` (modo conservador)

**Que es:**
Un modo opcional "Confirmar acciones" que pausa al agente antes de ejecutar herramientas de alto impacto: `create_project`, `create_budget`, `add_budget_items_batch`, `approve_budget`. El agente muestra que va a hacer (nombre de la herramienta + parametros clave) y espera "Aprobar" / "Cancelar" del usuario.

Diferente del Plan Mode (que planifica todo antes): este modo deja correr el agente libremente excepto en los puntos de mayor riesgo.

**Por que importa:**
El system prompt ya tiene logica de checkpoints textuales ("pregunta al usuario antes de hacer X"). Pero si el modelo falla al seguir esa instruccion (hallucination, context overflow), las acciones se ejecutan igual. `canUseTool` es una red de seguridad a nivel infraestructura, no dependiente del modelo.

Para el caso de uso construccion: crear un proyecto duplicado o aprobar un presupuesto incorrecto en el ERP puede causar problemas de datos que requieren soporte manual.

**Esfuerzo estimado:** Medio (2-3 dias)

**Implementacion:**

1. Toggle "Modo conservador" en la UI (settings o toolbar)
2. En `agentManager.ts`, cuando el modo esta activo, implementar `canUseTool` callback:
   - Para herramientas no destructivas: `return { behavior: 'allow', updatedInput: input }`
   - Para herramientas destructivas (`mcp__cerp__create_project`, `mcp__cerp__create_budget`, `mcp__cerp__add_budget_items_batch`, `mcp__cerp__approve_budget`): enviar evento IPC al renderer y esperar respuesta
3. Nuevo evento IPC: `AGENT_CONFIRM_TOOL` con `{ toolName, input, description }` y `AGENT_TOOL_DECISION` con `{ allow: boolean }`
4. Componente `ToolConfirmationBanner.tsx`: banner en la parte superior del chat con "El agente quiere [accion]. Parametros: [resumen]. ¿Aprobar?" + botones

**Archivos afectados:**
- `src/main/agent/agentManager.ts`
- `src/main/ipc/channels.ts`
- `src/renderer/src/hooks/useAgent.ts`
- `src/renderer/src/components/chat/` — nuevo componente banner

---

### PRIORIDAD MEDIA

---

#### MEJORA 6: Streaming de texto caracter a caracter (respuesta parcial visible)

**Que es:**
Mostrar el texto de respuesta del asistente a medida que se genera, caracter a caracter o por fragmentos, en lugar de esperar a que el turno complete.

**Estado actual:**
El agente usa `includePartialMessages: true` en las options (agentManager.ts linea 268) pero los textos solo se reciben como mensajes completos de tipo `assistant` con el bloque `text` completo. No hay streaming caracter a caracter en el IPC actual.

**Por que importa:**
Respuestas largas (analisis de presupuesto, descripcion de capitulos) aparecen de golpe cuando completan. Perceptualmente, el usuario espera varios segundos y luego recibe todo de una vez. El streaming incremental hace que la respuesta "aparezca escribiendose", lo que se percibe como mas rapido aunque el tiempo total sea el mismo.

**Esfuerzo estimado:** Alto (5-7 dias) — requiere cambios en el protocolo IPC y en el mapMessage del agentManager

**Implementacion:**

Opcion A (rapida, imperfecto): Simular typewriter en el renderer. Cuando llega un texto completo, animarlo caracter a caracter con un delay de 5-8ms por caracter. No es verdadero streaming pero visualmente es equivalente para textos cortos/medios.

Opcion B (correcta): Mapear los eventos `stream_event` del SDK (type `content_block_delta`, `text_delta`) al IPC y enviar fragmentos al renderer. Requiere cambiar `mapMessage()` para manejar deltas acumulativos y el hook `useAgent.ts` para acumular el texto en tiempo real.

Recomendacion: implementar primero Opcion A (1-2 dias), evaluar si es suficiente.

**Archivos afectados:**
- `src/main/agent/agentManager.ts` — mapMessage para deltas
- `src/main/ipc/types.ts` — nuevo event type `text_delta`
- `src/renderer/src/hooks/useAgent.ts` — acumulacion de texto incremental
- `src/renderer/src/components/chat/MessageBubble.tsx` — renderizado incremental

---

#### MEJORA 7: Panel de actividad separado del chat ("Bitacora de obra")

**Que es:**
Un panel lateral (drawer o tab) que muestra un log cronologico de todas las acciones que el agente ejecuto en la sesion: herramientas usadas, agentes invocados, archivos leidos/creados, datos consultados en CERP. Separado del historial de mensajes del chat.

Inspirado en el "activity panel" de las mejores apps de agentes 2026: "what was done, what is running, what is blocked, and what is next, in a single glance".

**Por que importa:**
Para cotizaciones largas (analisis de pliego de 200 paginas + Excel de 500 partidas + creacion de presupuesto completo en CERP), el log de acciones es la "bitacora de obra" digital. El usuario puede volver a ver exactamente que hizo el agente, en que orden, cuanto tardo cada paso.

Ademas tiene valor para soporte: si hay un error, el equipo CERP puede pedirle al usuario que comparta la bitacora de la sesion.

**Esfuerzo estimado:** Medio (3-4 dias)

**Implementacion:**

1. Acumular todos los eventos de tool en `useAgent.ts` en un array `activityLog: ActivityEntry[]` separado de los mensajes
2. Nuevo componente `ActivityPanel.tsx` — panel collapsible a la derecha del chat con lista de entradas cronologicas
3. Cada entrada: icono de herramienta, label, timestamp, duracion, input resumido, estado (en progreso / completado / error)
4. Boton de exportar a JSON o texto plano para compartir con soporte
5. Persistir en la conversacion para verlo al recargar

**Archivos afectados:**
- `src/renderer/src/hooks/useAgent.ts`
- `src/renderer/src/components/chat/ChatContainer.tsx`
- `src/renderer/src/components/chat/` — nuevo componente ActivityPanel

---

#### MEJORA 8: Titulos automaticos de conversaciones via IA

**Que es:**
En lugar de usar los primeros 50 caracteres del primer mensaje como titulo, hacer una llamada rapida (haiku) al final del primer turno para generar un titulo descriptivo de 4-6 palabras.

**Estado actual:**
`createConversation(title, 'orchestrator')` en ChatPage.tsx linea 99 usa `message.content.substring(0, 50)`. Si el primer mensaje es "Analiza esto" + ruta de archivo, el titulo queda como "Analiza esto C:/Users/...".

**Por que importa:**
Con muchas conversaciones en el panel, el usuario necesita identificarlas rapidamente. "Cotizacion Comisaria 7ma - Preliminares" es mucho mas util que "Dame un presupuesto para este...".

**Esfuerzo estimado:** Bajo-Medio (1-2 dias)

**Implementacion:**

Opcion simple: extraer titulo de la primera respuesta del agente. El agente suele empezar con un resumen del trabajo que va a hacer — extraer los primeros 60 caracteres de ese texto es mucho mas descriptivo que el prompt del usuario.

Opcion IA: llamada independiente con `query({ prompt: 'Genera un titulo de 5 palabras para esta conversacion: [primer intercambio]', options: { maxTurns: 1 } })` despues del primer turno.

**Archivos afectados:**
- `src/renderer/src/pages/ChatPage.tsx` — handleMessageComplete
- `src/renderer/src/hooks/useConversations.ts`

---

#### MEJORA 9: Arrastre de archivos con preview antes de enviar

**Que es:**
Cuando el usuario arrastra archivos al chat, en lugar de insertar el path en el textarea directamente, mostrar una tarjeta de preview con nombre, tipo, y tamano del archivo. El usuario puede ver que archivos va a enviar, agregar mas, o quitar alguno antes de hacer submit.

**Estado actual:**
`handleDrop` en ChatContainer.tsx inserta los paths como texto plano en el textarea. El usuario tiene que leer los paths para saber que archivos estan incluidos.

**Por que importa:**
Para presupuestistas que trabajan con multiples versiones de un mismo archivo (v1, v2, final, final_real), es comun arrastrar el archivo equivocado. Un preview con nombre y fecha de modificacion previene ese error.

**Esfuerzo estimado:** Bajo (1-2 dias)

**Implementacion:**

1. Al hacer drop, en lugar de insertar paths en el textarea, guardar en state `droppedFiles: File[]`
2. Mostrar tarjetas de preview debajo del textarea (nombre, extension, tamano)
3. Boton X para quitar un archivo antes de enviar
4. Al enviar, construir el prompt con los paths + el texto del textarea

**Archivos afectados:**
- `src/renderer/src/components/chat/ChatContainer.tsx`

---

#### MEJORA 10: Exportar conversacion a PDF o texto

**Que es:**
Boton "Exportar" en el panel de conversaciones que genera un PDF o archivo .txt con el historial completo de una conversacion: mensajes, herramientas usadas, archivos procesados, resultados.

**Por que importa:**
Para auditoria de obra: el jefe de obra quiere guardar el registro de como se genero un presupuesto. Para soporte: el equipo CERP necesita ver el historial para diagnosticar un error. Para compliance: en licitaciones publicas, el registro del proceso es requerido.

**Esfuerzo estimado:** Medio (2-3 dias)

**Implementacion:**

Usar la capacidad existente de generar PDFs con reportlab (Python) que ya tiene el agente `report-generator`. Alternativamente, implementar en el renderer con `window.cerpAPI.exportConversation(messages)` que escribe un archivo .txt o genera un PDF simple con Electron's `printToPDF`.

**Archivos afectados:**
- `src/main/ipc/` — nuevo handler
- `src/renderer/src/components/conversations/ConversationPanel.tsx`

---

### PRIORIDAD BAJA

---

#### MEJORA 11: Resize del panel de conversaciones

**Que es:**
Hacer el ancho del panel de conversaciones (actualmente fijo en 208px = w-52) redimensionable via drag.

**Por que importa:**
Para usuarios con titulos de conversaciones largos o que quieren ver mas contexto en el panel sin colapsar.

**Esfuerzo estimado:** Bajo (1 dia)

---

#### MEJORA 12: Keyboard shortcut para nueva conversacion

**Que es:**
`Cmd/Ctrl+N` para nueva conversacion. `Cmd/Ctrl+K` para buscar en conversaciones.

**Por que importa:**
Usuarios power que tienen muchas conversaciones abiertas necesitan navegar sin el mouse.

**Esfuerzo estimado:** Bajo (2-3 horas)

**Archivos afectados:**
- `src/renderer/src/components/chat/ChatContainer.tsx` — event listener global
- `src/renderer/src/components/conversations/ConversationPanel.tsx` — focus en el buscador

---

#### MEJORA 13: Indicador de presupuesto USD restante

**Que es:**
Mostrar cuanto del limite de $10 USD por sesion (maxBudgetUsd en agentManager.ts) se ha consumido, como una barra de progreso o porcentaje en el footer.

**Por que importa:**
El usuario de produccion no sabe que existe un limite de presupuesto por sesion. Si el agente se detiene en mitad de un presupuesto largo porque se agoto el budget, el usuario no entiende que paso.

**Esfuerzo estimado:** Bajo (1-2 horas) — requiere exponer `sessionCost` (ver Mejora 4) y compararlo con `maxBudgetUsd`

---

#### MEJORA 14: Estado de conexion con CERP (online/offline)

**Que es:**
Un indicador pequeno (punto verde/rojo) en la toolbar que muestra si el agente puede conectarse al cerp-server. Si el servidor esta caido o el usuario no tiene internet, mostrarlo antes de que el usuario intente una consulta de datos.

**Por que importa:**
Los subagentes `cerp-data` y algunas operaciones del orchestrator requieren conexion al backend. Si el backend esta caido, el agente falla en mitad de una tarea y el mensaje de error es tecnico ("fetch failed"). Un indicador proactivo gestiona mejor la expectativa.

**Esfuerzo estimado:** Bajo (1 dia)

---

## 4. Recomendaciones de implementacion

### Orden de implementacion sugerido para el proximo sprint

1. **Mejora 3** (showThoughts ON por default): 30 minutos, impacto inmediato en confianza del usuario. Hacerla ya.
2. **Mejora 4** (costo en tiempo real): 1-2 horas, el dato ya existe, solo falta mostrarlo.
3. **Mejora 2** (AskUserQuestion widget): 2-4 dias. Desbloquea el flujo de clarificacion estructurada que el system prompt ya pide.
4. **Mejora 1** (Plan Mode): 3-5 dias. La mas impactante para el caso de uso de cotizacion.
5. **Mejora 5** (confirmacion de herramientas destructivas): 2-3 dias. Red de seguridad critica para produccion.

### Sobre Plan Mode: implementacion tecnica especifica

El SDK soporta cambiar `permissionMode` dinamicamente durante una sesion via `setPermissionMode()`:

```typescript
// agentManager.ts — exponer metodo para cambiar modo desde IPC
export async function setPlanMode(enabled: boolean): Promise<void> {
  if (!activeQuery) return
  await activeQuery.setPermissionMode(enabled ? 'plan' : 'bypassPermissions')
}
```

El flujo UX recomendado:
1. Usuario activa "Modo revision" antes de enviar el mensaje
2. Agente recibe el prompt con `permissionMode: 'plan'`
3. Agente lee archivos, consulta datos, hace preguntas via `AskUserQuestion`
4. Al terminar el turno de planificacion, el agente devuelve un resumen del plan en texto
5. La UI muestra el resumen con dos botones: "Aprobar y ejecutar" / "Cancelar"
6. Si aprueba: `setPermissionMode('bypassPermissions')` y se envia el mismo prompt de nuevo (o "Procede con el plan")
7. Si cancela: nueva conversacion o mensaje de ajuste

### Sobre `canUseTool`: arquitectura IPC

El callback `canUseTool` corre en el proceso main de Electron. Para que la decision del usuario (que ocurre en el renderer) llegue al callback, se necesita un patron de Promise que se resuelve via IPC:

```typescript
// En agentManager.ts
let pendingToolApproval: ((decision: boolean) => void) | null = null

const options = {
  canUseTool: async (toolName: string, input: unknown) => {
    if (isDestructiveTool(toolName)) {
      // Enviar pregunta al renderer
      mainWindow.webContents.send('AGENT_CONFIRM_TOOL', { toolName, input })
      // Esperar decision del usuario
      const approved = await new Promise<boolean>((resolve) => {
        pendingToolApproval = resolve
      })
      pendingToolApproval = null
      return approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Usuario cancelo la accion' }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

// Handler IPC para cuando el usuario decide
ipcMain.handle('AGENT_TOOL_DECISION', (_, { allow }: { allow: boolean }) => {
  pendingToolApproval?.(allow)
})
```

---

## 5. Referencias

- [Configure permissions — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Streaming Input Mode — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Handle approvals and user input — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Agent UX: designing UI for AI agents in 2026 — Fuselab Creative](https://fuselabcreative.com/ui-design-for-ai-agents/)
- [Claude Desktop App Update: Latest Features 2026 — Blockchain News](https://blockchain.news/ainews/claude-desktop-app-update-latest-features-and-2026-productivity-boost-for-ai-coding-and-workflows)
- [Claude Code Desktop App redesign — VentureBeat](https://venturebeat.com/orchestration/we-tested-anthropics-redesigned-claude-code-desktop-app-and-routines-heres-what-enterprises-should-know)
- [AI Agent Design Best Practices — Hatchworks](https://hatchworks.com/blog/ai-agents/ai-agent-design-best-practices/)
- [Designing for AI Agents: 7 UX Patterns — Exalt Studio](https://exalt-studio.com/blog/designing-for-ai-agents-7-ux-patterns-that-drive-engagement)
