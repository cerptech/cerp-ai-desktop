# QA — CERP IA: cascada Item → Materiales → Recursos (BOM)

**Bug origen**: cuando CERP IA creaba un presupuesto desde un archivo del usuario, cada item del catalogo (`Items`) quedaba como "caja vacia": sin materiales (`materials_required: []`) y sin recursos (`resources_required` undefined). Esto rompia la cascada para almacen, ordenes de compra, ordenes de produccion y reportes de costos.

**Branch**: `feat/cerpia-budget-cascade-fix` en ambos repos (`cerp-server`, `cerp-ai-desktop`).

**Tarea Notion**: ERROR en CERP IA — In Dev, Muy alta, Fibonacci 3.

---

## Cambios bajo prueba

### Backend (`cerp-server`)
- `models/Sequence.ts`, `services/SequenceService.ts`: 3 nuevos modulos de secuencia — `material` (`MAT-XXXX`), `resource_labor` (`MO-XXXX`), `resource_equipment` (`EQ-XXXX`).
- `controllers/budgetBatchController.ts`: el payload `newProduct` ahora acepta `materialsRequired[]` y `resourcesRequired[]`. Lookup-or-create por `companyId+code` o `companyId+name` (case-insensitive). Codes generados con `SequenceService` si no vienen.
- `controllers/resourceController.ts`: `GET /resources` acepta `searchTerm` como alias de `search`.

### Desktop (`cerp-ai-desktop`)
- `agent/toolDefinitions.ts`: schema Zod de `add_budget_items_batch.newProduct` extendido con `materialsRequired` y `resourcesRequired`. `code` ahora es opcional. Nueva tool `search_resources`.
- `agent/systemPrompt.ts`: confirmacion graduada (lecturas sin, escrituras de alto impacto con), checkpoint masivo antes de `add_budget_items_batch`, seccion de transparencia para materiales/recursos nuevos (tabla previa, prefijos `MAT-`/`MO-`/`EQ-`), regla "NUNCA inventes costos — preguntale al usuario".

---

## Pre-requisitos

- Backend levantado en `localhost:8080` con `feat/cerpia-budget-cascade-fix` checked out.
- MongoDB local con datos demo (`npm run fresh-demo`).
- cerp-ai-desktop en modo dev (`npm run dev`) con `BACKEND_API_URL=http://localhost:8080/api`.
- Usuario logueado con companyId conocido.
- Archivo de prueba: cualquier Excel de mediciones con minimo 3 capitulos y 5+ items, idealmente con un APU (ej: "Hormigon armado H-25" con materiales + oficial + ayudante).

---

## Casos de prueba

### TC-01 — Item simple (sin BOM)
**Setup**: archivo con items planos: "Limpieza de terreno (m2, 500, €1,20/m2)".

**Pasos**:
1. Abrir cerp-ai-desktop. Pedirle: "Cargame el presupuesto de este archivo en CERP."
2. Confirmar cuando muestre el checkpoint.

**Resultado esperado**:
- El agente muestra una tabla previa con items + (en este caso) 0 materiales/recursos nuevos.
- En MongoDB, el `Items` creado tiene `materials_required: []` y `resources_required: []` (es item simple — esto es correcto).
- `BudgetItem.productSnapshot.costBreakdown.materials === 1.20`.
- El total del capitulo es `500 * 1.20 = 600`.

### TC-02 — Item compuesto (APU) con materiales + mano de obra nuevos
**Setup**: archivo con un APU tipo "Losa de hormigon H-25 (m2)" cuyo desglose incluye:
- 0.15 m3 de hormigon H-25
- 8 kg de hierro del 8mm
- 1.5 h de Oficial Albañil
- 1.5 h de Ayudante
- 0.2 h de Retroexcavadora

Ninguno existe en el catalogo.

**Pasos**:
1. Pedir al agente: "Cargame este presupuesto."
2. Verificar que el agente muestra la tabla de NUEVOS antes del batch.
3. Confirmar.

**Resultado esperado**:
- El agente lista los 5 nuevos elementos con prefijos `MAT-`, `MO-`, `EQ-` correctos (Retroexcavadora va a EQ, no a MO).
- Si en el archivo no hay costos para Oficial/Ayudante/Retro, el agente PREGUNTA antes de mandar el batch. No inventa €0 ni €20/h.
- Tras el batch:
  - 2 `Items` nuevos en colección `items` con codes `MAT-XXXX` correlativos (Hormigon H-25, Hierro 8mm).
  - 3 `Resource` nuevos en colección `resources`: 2 con prefijo `MO-` y type `labor`, 1 con prefijo `EQ-` y type `tools_machinery`.
  - El `Items` correspondiente al APU "Losa de hormigon H-25" tiene `materials_required` con 2 entradas y `resources_required` con 3 entradas.
  - `BudgetItem.productSnapshot.costBreakdown` esta recalculado desde el BOM: `materials = (0.15 * costHormigon + 8 * costHierro)`, `labor = (1.5 * costOficial + 1.5 * costAyudante)`, `equipment = 0.2 * costRetro`. NO es 0.
- `Sequence` muestra `lastNumber` incrementado para `material`, `resource_labor`, `resource_equipment`.

### TC-03 — Lookup-or-create reutiliza material existente
**Setup**: ya existe en el catalogo "Cemento Portland 50kg" con code `MAT-0001`. En el archivo nuevo, el APU pide "Cemento Portland 50kg" sin code.

**Pasos**:
1. Pedir al agente: "Cargame este presupuesto."
2. Confirmar cuando muestre que va a USAR el material existente (no crearlo de nuevo).

**Resultado esperado**:
- El agente NO marca "Cemento Portland 50kg" como nuevo en la tabla de transparencia.
- En MongoDB, NO se crea un segundo `Items` con nombre duplicado.
- El `materials_required` del APU referencia el `_id` del cemento preexistente (`MAT-0001`).
- La secuencia `material` NO se incrementa por este caso.

### TC-04 — `search_resources` desde el agente
**Pasos**:
1. Pedir al agente: "Mostrame los oficiales que tengo cargados."

**Resultado esperado**:
- El agente llama `search_resources` con `type: "labor"`.
- Devuelve solo recursos con `type=labor`, filtrados por companyId.
- El frontend de la app (que usa `search`, no `searchTerm`) sigue funcionando — no se rompio.

### TC-05 — Confirmacion graduada
**Pasos**:
1. Pedir al agente: "Listame mis proyectos." → no debe pedir confirmacion.
2. Pedir al agente: "Cargame este presupuesto." → DEBE mostrar checkpoint tabular antes de crear.
3. Pedir al agente: "Apruba el presupuesto." → DEBE confirmar antes de `approve_budget`.

### TC-06 — Costo faltante: el agente pregunta, no inventa
**Setup**: archivo con APU donde el oficial no tiene costo unitario en ninguna columna.

**Resultado esperado**:
- El agente, en la fase de preparacion del batch, pregunta al usuario: "El recurso 'Oficial Albañil' no tiene costo en el archivo. ¿A cuanto lo cotizas?". NO sigue con costRate=0.
- Si el usuario lo proporciona, lo usa. Si no responde, el batch no se manda.

### TC-07 — Retro-compatibilidad: payload viejo sigue funcionando
**Setup**: simular una llamada directa al endpoint con shape antiguo (`name` + `code` + `costBreakdown` agregado, sin `materialsRequired`).

**Pasos**:
1. POST `/api/budgets/:budgetId/items/batch` con un item `newProduct: { name, code, costBreakdown: { materials: 100 } }`.

**Resultado esperado**:
- El item se crea normalmente.
- `materials_required` queda en `[]` (no se popula con basura).
- `costBreakdown` se respeta tal cual (no se recalcula porque no hay BOM).
- Mismo comportamiento que antes del fix.

### TC-08 — Multi-tenant: no se cruzan empresas
**Setup**: dos companies (A y B). Compañia A tiene `Items` con name "Cemento Portland 50kg".

**Pasos**:
1. Loguearse con usuario de la compañia B.
2. Crear presupuesto con APU que requiere "Cemento Portland 50kg".

**Resultado esperado**:
- El lookup NO encuentra el cemento de la compañia A (porque tiene companyId distinto).
- Se crea un nuevo cemento para la compañia B con su propio `MAT-XXXX`.
- En MongoDB ambas empresas tienen su propio item con el mismo nombre pero distintos `_id` y `companyId`.

### TC-09 — Backend genera codes correlativos por compañia
**Setup**: company X tiene `Sequence` con `material.lastNumber = 7`.

**Pasos**:
1. Lanzar batch con 3 newProducts sin code.

**Resultado esperado**:
- Los 3 items reciben codes `MAT-0008`, `MAT-0009`, `MAT-0010`.
- `Sequence` queda en `lastNumber = 10`.
- No hay colision con codes existentes (índice unique sparse `code+companyId`).

### TC-10 — Verificacion post-batch
**Pasos**:
1. Despues de cualquier batch exitoso.

**Resultado esperado**:
- El agente llama `get_budget_items` y muestra un resumen al usuario: "Se cargaron N items en M capitulos, se crearon X materiales y Y recursos nuevos."

---

## Checklist multi-tenant (CRITICO)

Antes de aprobar el PR, validar manualmente que TODAS las queries añadidas filtran por `companyId`:

- [ ] `resolveOrCreateMaterials` — findOne by code: `{ code, companyId, deletedAt: null }` ✓
- [ ] `resolveOrCreateMaterials` — findOne by name: `{ name: regex, companyId, deletedAt: null }` ✓
- [ ] `resolveOrCreateMaterials` — findOne by id: `{ _id, companyId, deletedAt: null }` ✓
- [ ] `resolveOrCreateResources` — equivalente arriba ✓
- [ ] Items creados llevan `companyId` ✓
- [ ] Resources creados llevan `companyId` ✓
- [ ] `SequenceService.getNext(companyId, module)` — el counter es por companyId ✓

---

## Rollback plan

Si algo sale mal en staging:
1. Revertir merge de los dos PRs (cerp-server y cerp-ai-desktop) — `git revert -m 1 <merge-sha>`.
2. Re-deploy backend desde main.
3. Los `Sequence` documentos con los 3 nuevos modulos NO requieren cleanup (quedan ahi inocuos).
4. Items y Resources creados con codes `MAT-`/`MO-`/`EQ-` quedan validos — no requieren backfill.

## Backfill items "caja vacia" preexistentes

**Decision**: SKIP. Los items creados por CERP IA en versiones anteriores que quedaron sin BOM se quedan tal cual. Cualquier reconstruccion automatica seria adivinanza. El usuario los puede completar manualmente desde la UI de Items.
