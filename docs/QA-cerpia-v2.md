# Plan de pruebas — CERPIA V2 (Ideas 1, 2 y 3)

Pruebas **manuales en vivo** con las aplicaciones (Desktop + backend). No incluye tests automatizados.

## Preparación común (hacer una sola vez)

| Item | Detalle |
|---|---|
| Ramas | Desktop: `feat/desktop-onboarding-wizard`. Backend: `feat/desktop-onboarding-progress` (corre sobre la V2). |
| Backend | Tiene que estar corriendo y accesible desde el Desktop. |
| Cuenta de prueba | Usar una empresa con **plan ilimitado** o con **cotización gratis disponible** para la mayoría de los casos (evita cobros reales). Para los casos de pago (€19,99) usar Stripe en **modo test** con una tarjeta que NO pida autenticación adicional (SCA). |
| Logs | Tener a la vista la consola/log del proceso main del Desktop: ahí aparecen los eventos clave (`Turbo Mode ON…`, heartbeat, commit/refund). |
| Reset de onboarding | Para volver a ver el tutorial: botón "Cómo empezar" en el header, o borrar la clave `cerp-onboarding-progress` de localStorage + el progreso en backend. |

> **Limitaciones conocidas a tener presente (no son bugs):**
> - El caso SCA en pago directo hoy devuelve un error `AUTHENTICATION_REQUIRED` (no hay fallback a Checkout todavía) → usar tarjeta de test sin SCA.
> - Modo Turbo está en su versión MVP (sin "ultracode" puro). Verificar en el log que use `claude-opus-4-8`.

---

## Etapa 1 — Onboarding Wizard (tutorial guiado)

| # | Caso | Pasos | Resultado esperado |
|---|---|---|---|
| 1.1 | Auto-aparición primer uso | Abrir el Desktop con un usuario que nunca completó el tutorial | El wizard aparece solo, en el paso 1 de 6 |
| 1.2 | Recorrido completo | Avanzar los 6 pasos hasta el final | Barra de progreso avanza; al terminar, el wizard se cierra y NO vuelve a aparecer en próximos arranques |
| 1.3 | Paso 3 (carpeta) | Llegar al paso 3 | Queda seteada la carpeta real de trabajo del chat (el `cwd` del chat refleja la carpeta) |
| 1.4 | Paso 4 (prompt) | Llegar al paso 4 | Se inyecta un prompt de ejemplo en el chat (acción rápida) |
| 1.5 | Saltar con confirmación | Hacer click en "Saltar" | Pide confirmación; al confirmar, el wizard se cierra y no reaparece |
| 1.6 | Relanzar | Click en "Cómo empezar" en el header | El wizard se reabre desde el paso 1 |
| 1.7 | Persistencia | Completar/saltar, cerrar y reabrir la app | El estado se respeta (no reaparece). Validar que sobrevive aun sin red (el backend es la fuente de verdad pero hay espejo local) |
| 1.8 | No toca el estado web | Completar el tutorial | Solo se marca el onboarding del Desktop; el estado de registro web del usuario no cambia |

---

## Etapa 2 — Cortafuegos de cotización (no se cobra sin entregable válido)

> Concepto a verificar en todos los casos: el crédito se **reserva** al arrancar y **solo se consume/cobra al final si la cotización es válida** (≥1 ítem real, total > 0, sin capítulos vacíos).

| # | Caso | Pasos | Resultado esperado |
|---|---|---|---|
| 2.1 | **Happy path** | Pedir una cotización normal y dejar que la complete (proyecto + capítulos + ítems + costos) | Banner "Generando…" (celeste) durante el proceso → al cerrar, banner verde "Cotización generada correctamente. Se aplicó el crédito". El badge de créditos baja en 1 (o no, si es ilimitado) |
| 2.2 | **Pre-flight (falta info)** | Pedir una cotización sin adjuntar archivo ni dar mediciones | El agente NO arranca a crear nada ni reserva crédito: pide lo que falta. El badge de créditos no cambia |
| 2.3 | **Post-flight fail / replay Pau V** | Forzar una cotización que termine mal (ej. solo capítulos sin ítems, o total 0) | Banner ámbar: **"No se aplicó ningún cargo ni se consumió el crédito"** + motivo + invitación a reintentar. El badge de créditos NO baja |
| 2.4 | Limpieza tras rollback | Después del caso 2.3, revisar en CERP los presupuestos | El presupuesto inválido quedó descartado (soft-delete): no aparece basura con capítulos vacíos |
| 2.5 | **Timeout / tarea colgada** | Para acelerar: setear en backend `QUOTE_WATCHDOG_STALE_MIN=1` y el cron a cada minuto. Arrancar una cotización y **cerrar la app** a mitad (o cortar la red) | Tras ~1–2 min, el watchdog libera la reserva: el crédito vuelve a estar disponible. Si el usuario estaba conectado, recibe el aviso de que no se completó y no hubo cargo |
| 2.6 | Cancelación manual | Arrancar una cotización y cancelarla/abortarla antes de terminar | La reserva se libera; no hay cargo; el crédito sigue disponible |
| 2.7 | Pago directo €19,99 (Stripe test) | Con cuenta sin gratis ni créditos, confirmar el costo y completar una cotización **válida** | Se confirma el costo ANTES de arrancar; al validar OK, recién ahí se cobra (en Stripe test aparece el cargo capturado) |
| 2.8 | Pago + entregable inválido | Igual que 2.7 pero forzando salida inválida | En Stripe test NO queda cargo capturado (la autorización se cancela). Badge sin cambios. Banner ámbar |
| 2.9 | Historial de créditos | Click en "Historial" en el header | Se abre el panel con las cotizaciones: marca cuáles consumieron crédito, cuáles no, y el motivo (ej. "La cotización no superó la validación") |
| 2.10 | Regresión históricos | Revisar cotizaciones viejas (previas a esta feature) en el historial | Aparecen como "Crédito consumido" (no se rompen ni se re-evalúan) |

---

## Etapa 3 — Modo Turbo (cotización exhaustiva)

| # | Caso | Pasos | Resultado esperado |
|---|---|---|---|
| 3.1 | Toggle visible y off por defecto | Abrir el chat | El pill "Turbo" (violeta) aparece junto a "Modo plan", **apagado** por defecto |
| 3.2 | Activar / banner | Click en "Turbo" | El pill queda en ON; aparece el banner violeta arriba: "esta cotización usa más recursos y tarda más, a cambio de mayor precisión" |
| 3.3 | Modelo correcto (no degrada) | Con Turbo ON, mandar un mensaje y mirar el log del main | Debe loguear `Turbo Mode ON — model=claude-opus-4-8, effort=xhigh, workflows enabled` |
| 3.4 | Persistencia del toggle | Activar Turbo, cerrar y reabrir la app | El toggle queda en el estado que se dejó (se hidrata al arrancar) |
| 3.5 | **Replay Pau V con Turbo ON** | Repetir el caso complejo que antes fallaba (el de 2.3), pero con Turbo activado | Ahora **entrega la cotización completa**: capítulos con ítems, APUs con cantidades/precios, total > 0 → cierra con commit válido (banner verde). Es la prueba de que Turbo *previene* lo que el cortafuegos *contiene* |
| 3.6 | UX no "congelada" | Durante una cotización Turbo larga | El indicador de actividad sigue vivo (no parece colgado) aunque haya pausas largas de razonamiento |
| 3.7 | Convive con Plan Mode | Activar Plan Mode y Turbo juntos | Plan Mode sigue funcionando (el agente planifica sin escribir); no se rompe ningún flujo |
| 3.8 | Convive con preguntas | En una cotización Turbo, provocar que el agente use el widget de preguntas (ask_user_question) | El widget de preguntas funciona normal; al responder, el agente continúa |
| 3.9 | Costo real (medición) | Correr 1–2 cotizaciones Turbo y anotar el costo/tokens del log | Registrar el costo en USD por cotización (para decidir pricing más adelante) |
| 3.10 | Normal sin Turbo | Con Turbo OFF, una cotización simple | Usa el modelo/effort normal (más rápido, más barato) — Turbo no se activa solo |

---

**Criterio de aceptación global:** ningún crédito se consume sin una cotización válida y accesible (Etapa 2), y el caso Pau V que motivó todo esto se resuelve por los dos lados — prevenido con Turbo ON (3.5) y contenido sin Turbo (2.3).
