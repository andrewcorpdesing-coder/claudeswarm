# HiveClaude

**Coordina múltiples instancias de Claude Code para que trabajen juntas en un mismo proyecto.**

HiveClaude es un broker MCP local que conecta varios agentes Claude Code entre sí. Cada agente tiene un rol (orquestador, coder, reviewer, etc.), comparte estado en una pizarra común, se coordina con tareas, bloqueos de archivos y mensajes directos — todo sin salir del terminal.

```
┌─────────────────────────────────────────────────────────┐
│                    Tu proyecto                          │
│                                                         │
│  agents/orchestrator/   agents/coder-backend/   ...    │
│  ┌─────────────────┐    ┌─────────────────┐            │
│  │  Claude Code    │    │  Claude Code    │            │
│  │  CLAUDE.md      │    │  CLAUDE.md      │            │
│  │  .mcp.json ─────┼────┼─── .mcp.json   │            │
│  │  hooks/         │    │  hooks/         │            │
│  └────────┬────────┘    └────────┬────────┘            │
│           │                      │                      │
│           └──────────┬───────────┘                      │
│                      ▼                                  │
│              ┌───────────────┐                          │
│              │  hive broker  │  :7432                  │
│              │  /mcp  /ping  │                          │
│              │  SQLite + BB  │                          │
│              └───────────────┘                          │
└─────────────────────────────────────────────────────────┘
```

---

## Por qué usar HiveClaude

### Mejor calidad de código — el reviewer realmente funciona

Un solo agente que implementa y luego "revisa" su propio código es el mismo modelo con el mismo sesgo. El reviewer de HiveClaude es una instancia separada que llega al código sin saber cómo fue construido — igual que un code review real. Detecta cosas distintas porque no cargó la historia de implementación.

### Contexto enfocado — menos degradación en proyectos largos

Un agente único que trabaja en un proyecto grande acumula contexto de todo: frontend, backend, tests, errores pasados, caminos descartados. La calidad baja conforme el contexto crece. Con agentes especializados, cada uno carga solo lo que necesita. El coder-backend no sabe nada de CSS. El reviewer no sabe cómo se implementó la función. Eso mantiene la calidad estable.

### Paralelismo real en trabajo delimitado

Mientras coder-backend implementa la API, coder-frontend ya construye los componentes. El broker gestiona las dependencias — frontend no empieza hasta que backend pasa QA, pero si son independientes corren al mismo tiempo. Para proyectos con partes bien separadas, el tiempo total se reduce.

### Para quién tiene sentido

| Escenario | Vale la pena |
|---|---|
| Proyecto con backend y frontend desacoplados | Sí |
| Quieres QA obligatorio en cada tarea | Sí |
| Feature grande con subtareas independientes | Sí |
| Script pequeño o tarea de 10 minutos | No — un solo agente es más rápido |
| Todo depende de todo secuencialmente | No — el paralelismo no ayuda |

---

## ⚠️ Aviso

- **Beta:** v0.6 — coordinación adaptativa completa + QA verificación activa + self-review imposible. Tests estables. Úsalo en proyectos reales con precaución.
- **Costo:** cada agente consume tokens de forma independiente — 4 agentes activos equivale a 4x el consumo normal de Claude Code
- **Permisos:** el flag `--yolo` elimina las confirmaciones de Claude Code — revisa bien el plan antes de aprobarlo

---

## Prerequisitos

- **Node.js 22+** (usa `node:sqlite` built-in)
- **Claude Code** instalado (`npm install -g @anthropic-ai/claude-code`)
- **npm 10+**

---

## Instalación

### Opción A — Desde el repositorio (desarrollo local)

```bash
git clone https://github.com/andrewcorpdesing-coder/hiveclaude
cd hiveclaude
npm install
npm run build
npm run link:local      # registra 'hiveclaude' globalmente via npm link
```

### Opción B — Desde npm

```bash
npm install -g hiveclaude
```

---

## Quick Start

### Forma rápida — un solo comando

```bash
cd mi-proyecto
hiveclaude init
hiveclaude run "implementa autenticación JWT"
```

`hiveclaude run` arranca el broker, abre terminales para los agentes principales (orchestrator, coder-backend, coder-frontend, reviewer) y encola la tarea en un solo paso. Cada agente empieza solo al presionar Enter en su terminal.

### Forma manual — control total

```bash
# 1. Inicializar en tu proyecto
cd mi-proyecto
hiveclaude init

# 2. Arrancar el broker en background
hiveclaude start

# 3. Crear directorios de agentes con prompts, hooks MCP y ramas git
hiveclaude scaffold

# 4. Abrir terminales por rol
hiveclaude exec --launch orchestrator coder-backend reviewer

# 5. El orquestador presentará un plan en su terminal.
#    Cuando esté listo, apruébalo desde cualquier terminal:
hiveclaude approve
```

---

## Flujo de trabajo

### 1. Planning Protocol

El orquestador nunca ejecuta sin plan aprobado. El flujo es siempre:

```
orquestador recibe tarea
       ↓
hace preguntas al usuario si necesita claridad
       ↓
presenta plan estructurado en su terminal:
  - SCOPE / OUT OF SCOPE
  - FILES que se tocarán
  - TASKS con rol y dependencias
  - ASSUMPTIONS
       ↓
espera aprobación (hive_wait)
       ↓
  hiveclaude approve  ←── tú desde la CLI
       ↓
crea tareas y notifica a los workers
```

Puedes ver el plan en cualquier momento:

```bash
hiveclaude plan            # muestra el plan actual (draft o aprobado)
hiveclaude approve         # aprueba el plan — el orquestador empieza a crear tareas
hiveclaude reject "texto"  # rechaza con feedback — el orquestador revisa y re-presenta
```

### 2. Ejecución y QA

Los workers toman tareas via `hive_get_next_task`. El DAG de dependencias es automático — cuando una tarea es aprobada por QA, el broker desbloquea las dependientes y notifica a los agentes del rol correcto con un evento `task_available`. No hace falta coordinación manual.

El reviewer opera solo a través del pipeline QA:
- Recibe evento `task_submitted_for_qa`
- Llama `hive_get_pending_reviews` para ver la cola
- Aprueba o rechaza con `hive_submit_review`
- Nunca reclama tareas normales — solo revisa

### 3. Fin de sesión

Cuando todas las tareas están completadas, el broker emite automáticamente `sprint_complete` a todos los agentes. Cada uno llama `hive_end_session` y para. El orquestador guarda el contexto en `knowledge.session_log` para que la próxima sesión retome sin re-explorar el proyecto.

---

## Comandos CLI

| Comando | Descripción |
|---------|-------------|
| `hiveclaude init [nombre]` | Crea `.hive/` con config, `.mcp.json` en la raíz y modelos por defecto |
| `hiveclaude start` | Arranca el broker como daemon (PID en `.hive/broker.pid`) |
| `hiveclaude stop` | Para el broker |
| `hiveclaude restart [--keep-blackboard]` | Para, limpia estado y arranca de nuevo |
| `hiveclaude status` | Estado del broker, agentes online, sesiones activas |
| `hiveclaude agents` | Lista agentes conectados con rol y estado |
| `hiveclaude tasks [--status <estado>]` | Lista tareas (pending, in\_progress, completed…) |
| `hiveclaude prompt <rol> [-i id] [-o path]` | Imprime o guarda el system prompt para un rol |
| `hiveclaude scaffold [--force]` | Crea `agents/<rol>/` con CLAUDE.md, .mcp.json, hooks y ramas git. `--force` sobreescribe CLAUDE.md existentes |
| `hiveclaude exec [roles…] [--launch] [--yolo]` | Imprime los comandos `claude` a ejecutar por rol (o abre terminales con `--launch`) |
| `hiveclaude run [tarea] [--roles roles…] [--yolo]` | Arranca broker + agentes en un solo comando, opcionalmente encolando una tarea |
| `hiveclaude task "descripción"` | Encola una tarea para el orquestador sin reiniciar agentes |
| `hiveclaude plan` | Muestra el plan actual del orquestador (draft o aprobado) |
| `hiveclaude approve` | Aprueba el plan — el orquestador empieza a crear tareas |
| `hiveclaude reject "feedback"` | Rechaza el plan con feedback — el orquestador lo revisa |
| `hiveclaude cleanup [--db] [--blackboard] [--branches] [--all]` | Resetea estado del broker |

---

## Roles disponibles

| Rol | Responsabilidad |
|-----|----------------|
| `orchestrator` | Planifica, coordina el trabajo, crea tareas tras aprobación del usuario |
| `coder-backend` | Implementa lógica de servidor, APIs, base de datos |
| `coder-frontend` | Implementa UI, componentes, estilos |
| `reviewer` | Revisa código en el pipeline QA, aprueba o rechaza con feedback |
| `architect` | Define estructura, toma decisiones de diseño de alto nivel |
| `researcher` | Investiga librerías, APIs externas, mejores prácticas |
| `devops` | Gestiona infraestructura, CI/CD, despliegues |

No necesitas usar todos los roles — arranca con `orchestrator` + 1-2 coders.

### Selección de modelo por rol

```bash
hiveclaude exec                                                        # imprime comandos (no abre nada)
hiveclaude exec orchestrator:opus coder-backend:sonnet reviewer:haiku  # override por rol
hiveclaude exec --launch orchestrator coder-backend reviewer           # abre todos en una sola ventana (tabs)
hiveclaude exec --launch --yolo orchestrator coder-backend reviewer    # sin prompts de permisos
```

`--launch` abre **una sola ventana** de Windows Terminal con paneles divididos y `--dangerously-skip-permissions` activado para que los agentes corran sin prompts. Layout adaptativo:
- **3 agentes** (el caso típico): orquestador a la izquierda (altura completa), workers apilados a la derecha
- **2 agentes**: lado a lado
- **4+ agentes**: apilados horizontalmente

En macOS abre tabs en Terminal.app. En Linux abre una ventana por agente como fallback.

| Rol | Modelo sugerido | Por qué |
|-----|----------------|---------|
| `orchestrator` | Opus | Planificación, DAG de tareas, decisiones de alto nivel |
| `architect` | Opus | Diseño de sistemas, trade-offs técnicos complejos |
| `coder-backend` | Sonnet | Implementación con buen balance calidad/costo |
| `coder-frontend` | Sonnet | Idem |
| `reviewer` | Sonnet | Necesita razonamiento pero no tanta profundidad |
| `researcher` | Haiku | Búsquedas, recopilación de información |
| `devops` | Haiku | Scripts, configuración, tareas repetitivas |

---

## Cómo funciona

### Conexión MCP

Cada directorio `agents/<rol>/` contiene un `.mcp.json` que apunta al broker:
```json
{
  "mcpServers": {
    "hivemind": {
      "type": "http",
      "url": "http://localhost:7432/mcp"
    }
  }
}
```
Claude Code lo detecta automáticamente al abrir ese directorio.

### Herramientas MCP disponibles para los agentes

| Herramienta | Quién la usa | Descripción |
|-------------|-------------|-------------|
| `hive_register` | Todos | Registrarse en el broker (primera llamada obligatoria) |
| `hive_wait` | Todos | Bloquea hasta que el broker tenga eventos — cero tokens mientras idle |
| `hive_heartbeat` | Workers | Keep-alive de locks durante trabajo activo (cada 55s) |
| `hive_send` | Todos | Mensaje directo a otro agente o broadcast |
| `hive_list_agents` | Todos | Ver agentes online y su estado |
| `hive_create_task` | Orchestrator | Crear tarea con prioridad, dependencias y rol asignado. `estimated_duration_minutes` alimenta el scheduler CPM (default: 60 min) |
| `hive_get_next_task` | Workers | Obtener la siguiente tarea disponible (no disponible para reviewer) |
| `hive_update_task_progress` | Workers | Reportar progreso en una tarea |
| `hive_complete_task` | Workers | Marcar tarea como completa con evidencia de verificación |
| `hive_get_task` | Todos | Ver detalle de una tarea |
| `hive_list_tasks` | Todos | Listar tareas con filtros |
| `hive_blackboard_read` | Todos | Leer estado compartido (dot-notation: `project.meta`) |
| `hive_blackboard_write` | Todos | Escribir en la pizarra compartida |
| `hive_declare_files` | Workers | Declarar archivos que este agente va a modificar |
| `hive_request_lock` | Workers | Solicitar bloqueo exclusivo o compartido sobre archivos |
| `hive_release_locks` | Workers | Liberar bloqueos al terminar |
| `hive_get_pending_reviews` | Reviewer | Ver tareas esperando revisión QA |
| `hive_submit_review` | Reviewer | Aprobar o rechazar con feedback específico |
| `hive_merge_branch` | Orchestrator | Mergear rama `hive/<rol>` a main tras QA |
| `hive_add_dependency` | Orchestrator | Añadir dependencia entre dos tareas existentes (detección de ciclos) |
| `hive_auto_plan` | Orchestrator | Persistir plan + auto-aprobar si risk=low (proyecto conocido + modo flowing) |
| `hive_verify_task` | Reviewer | Ejecutar checks automáticos antes de aprobar: tsc, file_exists, exec, http shape validation |
| `hive_end_session` | Todos | Guardar resumen de sesión antes de parar |
| `hive_audit_log` | Todos | Consultar registro de auditoría |

### Eventos del broker (recibidos via `hive_wait`)

| Evento | Quién lo recibe | Qué significa |
|--------|----------------|---------------|
| `task_available` | Workers del rol correcto | Una tarea bloqueada quedó desbloqueada — llamar `hive_get_next_task` |
| `sprint_complete` | Todos | Todas las tareas están completadas — llamar `hive_end_session` |
| `task_submitted_for_qa` | Reviewer | Una tarea fue enviada a QA |
| `task_approved` | Worker asignado + Orchestrator | El reviewer aprobó la tarea |
| `task_rejected` | Worker asignado + Orchestrator | El reviewer rechazó la tarea con feedback |
| `agent_joined` | Todos | Un nuevo agente se conectó |
| `lock_granted` | Worker en espera | El archivo solicitado está disponible |
| `lock_contention_notice` | Worker que tiene el lock | Otro agente espera ese archivo |
| `message_received` | Destinatario | Mensaje directo o broadcast |
| `plan_approved` | Orchestrator | El usuario aprobó el plan vía `hiveclaude approve` |
| `plan_rejected` | Orchestrator | El usuario rechazó el plan con feedback |
| `new_input` | Orchestrator | Nueva tarea encolada vía `hiveclaude task` o `hiveclaude run` |

### Pizarra compartida (Blackboard)

Estado compartido persistido en SQLite (`.hive/tasks.db`, tabla `blackboard`) con dual-write a `.hive/blackboard.json` para compatibilidad. Estructura:

```
project.meta            — metadatos del proyecto
project.architecture    — decisiones de arquitectura
project.conventions     — convenciones de código
knowledge.discoveries   — hallazgos relevantes
knowledge.warnings      — problemas conocidos
knowledge.external_apis — contratos de APIs externas
knowledge.session_log   — historial de sesiones del orquestador
state.current_plan      — plan activo (draft → approved → executing → completed)
state.sprint            — sprint actual
state.blockers          — bloqueos activos
state.milestones        — hitos del proyecto
state.pending_input     — tarea encolada esperando al orquestador
agents.<id>             — estado por agente
qa.findings             — resultados de QA
qa.metrics              — métricas de calidad
qa.pending_review       — cola de revisiones pendientes
```

### Bloqueos de archivos

Antes de editar un archivo, el agente declara qué archivos toca. Si otro agente tiene el archivo bloqueado, espera en cola y recibe `lock_granted` cuando queda libre. Tipos de lock: `EXCLUSIVE` (escritura), `READ` (lectura compartida), `SOFT` (referencia sin bloqueo).

### Pipeline de QA

Las tareas completadas por workers pasan a `qa_pending`. El reviewer las inspecciona con `hive_get_pending_reviews` y antes de aprobar o rechazar ejecuta `hive_verify_task` — checks automáticos (tsc, file_exists, http shape validation, exec) que convierten el review de razonamiento en verificación determinista.

Al aprobar:

- La tarea pasa a `completed`
- El broker desbloquea automáticamente las tareas dependientes
- Los agentes del rol correcto reciben `task_available` y retoman trabajo sin intervención del orquestador
- Si todas las tareas están completadas, el broker emite `sprint_complete` a todos los agentes

Si son rechazadas, vuelven al agente original (`needs_revision`) con feedback específico y accionable.

**Self-review imposible:** el broker rechaza con `SELF_REVIEW_FORBIDDEN` cualquier intento de un agente de aprobar su propia tarea — independientemente del prompt. Un agente que actúa solo nunca puede completar el ciclo completo.

El orquestador **nunca crea tareas con `assigned_role: reviewer`**. El reviewer solo opera a través del pipeline QA, no como worker normal.

### Auto-heartbeat

`hive scaffold` genera un hook `PostToolUse` en cada directorio de agente. Cada vez que el agente ejecuta `Write`, `Edit` o `MultiEdit`, el hook dispara automáticamente un heartbeat al broker — manteniendo la sesión y los file locks vivos sin que el agente tenga que recordarlo.

### Workflow de ramas git

Si el proyecto es un repositorio git, `hive scaffold` crea la rama `hive/<rol>` para cada agente. El orquestador mergea el trabajo aprobado a `main`:

```
coder trabaja en hive/coder-backend
    ↓
QA aprueba
    ↓
orchestrator → hive_merge_branch("hive/coder-backend", task_id)
    ↓
main siempre tiene solo código aprobado
```

Si hay conflictos de merge, el tool aborta limpiamente y devuelve la lista de archivos en conflicto.

### Persistencia de sesión

Antes de parar, el orquestador guarda el contexto de la sesión con `hive_end_session`:

```json
{
  "key_decisions": ["Elegimos JWT con 1h expiry"],
  "next_actions": ["Implementar DELETE /users/:id"],
  "warnings": ["Migración falla si DB_URL no está en el entorno"],
  "tasks_completed": ["task-1", "task-2"],
  "tasks_blocked": ["task-3"]
}
```

Al arrancar la próxima sesión, el orquestador lee `knowledge.session_log` y retoma el trabajo sin re-explorar el proyecto desde cero.

---

## Coordinación adaptativa (v0.2–v0.5)

El broker no es solo un router — es un coordinador activo que aprende y actúa.

### Thompson Sampling — routing por calidad con decay temporal (v0.3)

`hive_get_next_task` no devuelve tareas en orden FIFO. Usa Thompson Sampling Beta(α,β) combinado con decay temporal para priorizar la siguiente tarea:

```
composite = θ×0.5 + decayScore×timeFactor×0.5
timeFactor = 0.2 + 0.8×e^(-age/τ)
```

τ varía por tipo de tarea: bugfix=12h (urgente), feature=48h, architecture=72h. Tareas antiguas salen de la cola antes de que expiren sus ventanas de relevancia. El historial persiste en `.hive/tasks.db`.

### HeterosynapticCapture — propagación de señales de calidad (v0.2–v0.3)

Cuando el reviewer rechaza con `severity: "critical"`, la señal se propaga hacia adelante:

- La tarea rechazada recibe `quality_floor = 0.85` (Tier 1)
- Todas las tareas pendientes que tocan los mismos archivos reciben `quality_floor = 0.70` (Tier 2)
- El floor **decae** con cada aprobación: `floor × e^(-1/5)` — ~5 aprobaciones para reducirlo a la mitad

Esto significa que un error crítico eleva el estándar para ese módulo sin intervención manual, y que la señal de error desaparece orgánicamente si el módulo luego funciona bien.

### DAG de dependencias + Critical Path Method (v0.4–v0.6)

Las dependencias entre tareas son un grafo real persistido en SQLite. `hive_add_dependency` añade aristas con detección de ciclos (Kahn's BFS). El broker ejecuta CPM (ES/EF/LS/LF, Float=0 = crítico) en dos lugares:

- **Scheduler** (`getNextAvailable`): ordena tareas disponibles por `is_critical_path DESC, float_minutes ASC` — las tareas en la ruta crítica salen primero de la cola, reduciendo makespan. El campo `estimated_duration_minutes` en `hive_create_task` alimenta este cálculo (default: 60 min). CPM se recalcula automáticamente al crear tareas y al aprobar revisiones.
- **FEP health probe** (`critical_path_health`): solo alerta cuando tareas en estado `blocked` tienen Float≈0. Bloqueos fuera de la ruta crítica no degradan el probe.

### HiveCriticalityEngine — κ (salud sistémica)

El broker mide κ ∈ [0,1] sobre 3 probes (routing entropy, completion variance, review score variance). κ indica si el equipo está en la zona óptima de coordinación (borde del caos, κ ∈ [0.40, 0.60]) o drifteando hacia rigidez o caos.

Disponible en `GET /admin/health`. El monitor lo muestra en tiempo real.

### FreeEnergyCoordinator — F con loop de aprendizaje (v0.2–v0.3)

El coordinator calcula F = Σwᵢ·Uᵢ sobre 6 probes cada N minutos (adaptativo según modo):

| Probe | Peso | Qué mide |
|-------|------|----------|
| critical_path_health | 0.30 | Tareas bloqueadas en ruta crítica (CPM) |
| agent_quality_trend | 0.20 | Tasa de rechazo de los últimos 10 reviews |
| lock_contention | 0.15 | Locks en cola / locks activos |
| estimate_deviation | 0.15 | Tareas que tardan >2× su estimado |
| context_budget_health | 0.12 | Agentes con tareas >2h en curso |
| human_feedback_latency | 0.08 | Tiempo esperando aprobación humana |

Cada intervención queda registrada en `coordinator_interventions` (SQLite). El F real 30 minutos después retroalimenta si la intervención funcionó. Con ≥30 outcomes, `calibrateWeights()` ajusta los pesos por gradient descent — los probes que más reducen F reciben más peso.

Cuando F ≥ 0.55 el coordinator envía eventos a los agentes relevantes. Cuando F ≥ 0.80 envía `coordinator_critical_alert` a todos y el orquestador detiene nuevas asignaciones.

### Verificación activa del reviewer — hive_verify_task (v0.6)

El reviewer no es solo un agente de razonamiento — tiene acceso a `hive_verify_task` para ejecutar checks concretos antes de aprobar cualquier tarea:

| Tipo de check | Qué verifica |
|---|---|
| `tsc` | TypeScript compila sin errores en el directorio del proyecto |
| `file_exists` | El archivo fue realmente creado en la ruta esperada |
| `exec` | Un comando termina con el exit code esperado |
| `http` | Un endpoint devuelve el shape de respuesta correcto (BFS deep search: si `kappa` no está en la raíz, lo busca en `criticality.kappa` y reporta exactamente dónde está y dónde debería estar) |

Esto cierra el gap entre "el código razonablemente parece correcto" y "el código funciona". Los bugs de contrato de API — que pasan `tsc --noEmit` pero fallan en runtime por shape mismatches — son detectables directamente.

### Auto-ejecución del orquestador (v0.5)

Cuando el proyecto tiene historial, el sistema está en modo `flowing` (F < 0.30), y el objetivo es de bajo riesgo (más archivos nuevos que modificados, sin tareas de arquitectura, < 4h estimado), el orquestador puede llamar `hive_auto_plan` con `risk="low"` y recibir `auto_approved=true` — crea las tareas sin esperar aprobación humana.

---

## Monitor en tiempo real

Con el broker corriendo, abre en el navegador:

```
http://localhost:7432/monitor
```

Dashboard con auto-refresh cada 3 segundos.

**Franja de coordinación (parte superior):**

| Panel | Qué leer |
|-------|----------|
| **Criticality κ** | Zona actual (rigid / sub_critical / **optimal** / super_critical / chaotic) + trend (↑ rising / → stable / ↓ falling) + 3 probe bars |
| **Free Energy F** | Modo actual (flowing / monitoring / active / **critical**) + 6 probe bars con contribuciones + tiempo del último tick |

Los colores son intuitivos: verde = bien, amarillo = atención, naranja = problemas, rojo = crítico.

**Tareas:** el badge `floor 0.85` aparece en cualquier tarea con quality_floor elevado — visible de un vistazo cuáles están marcadas por rechazos críticos anteriores.

---

## Admin API

El broker expone endpoints REST para monitoreo externo y control desde la CLI:

```
GET  /ping                                — health check
GET  /admin/agents[?status=online]        — listar agentes
DEL  /admin/agents/:id                    — forzar agente offline
POST /admin/agents/:id/heartbeat          — heartbeat externo (usado por hooks)
GET  /admin/tasks[?status=...]            — listar tareas
GET  /admin/tasks/:id                     — detalle de tarea
POST /admin/tasks/:id/force-complete      — completar tarea sin QA
GET  /admin/locks                         — bloqueos activos y en cola
GET  /admin/blackboard                    — snapshot completo de la pizarra
GET  /admin/audit[?agent_id=&action=&result=&since=&limit=]
POST /admin/input                         — encolar tarea para el orquestador (usado por hiveclaude task / hiveclaude run)
GET  /admin/plan                          — plan actual del orquestador
POST /admin/plan/approve                  — aprobar plan (usado por hiveclaude approve)
POST /admin/plan/reject                   — rechazar plan con feedback (usado por hive reject)
GET  /admin/health                              — CriticalityReport: κ, zona, trend, 3 probes (persiste snapshot)
GET  /admin/health/history[?limit=N]            — histórico de snapshots de κ + calibración PCA si ≥30
GET  /admin/coordinator                         — FepReport: F, modo, 6 probes (dispara tick, actualiza blackboard)
GET  /admin/coordinator/interventions[?limit=N] — historial de intervenciones + calibración si ≥30 outcomes
```

---

## Estructura de archivos generada

```
mi-proyecto/
├── .mcp.json                      ← Claude Code lo lee en la raíz
├── .hive/
│   ├── hive.config.json           ← config del broker (port, models por rol)
│   ├── tasks.db                   ← SQLite (tareas, mensajes, locks, audit)
│   ├── blackboard.json            ← pizarra compartida
│   ├── broker.pid                 ← PID del daemon
│   └── broker.log                 ← logs del broker
└── agents/
    ├── orchestrator/
    │   ├── CLAUDE.md              ← system prompt completo del rol
    │   ├── .mcp.json              ← apunta a http://localhost:7432/mcp
    │   ├── .hive-agent-id         ← ID del agente (orchestrator-1)
    │   └── .claude/
    │       ├── settings.json      ← hook PostToolUse configurado
    │       └── hooks/
    │           └── post-write-heartbeat.js
    ├── coder-backend/
    │   └── ... (misma estructura)
    └── ...

# Si el proyecto es un git repo, hive scaffold también crea:
git branch hive/orchestrator
git branch hive/coder-backend
git branch hive/coder-frontend
... etc.
```

---

## Cuántos agentes usar

| Configuración | Agentes | Cuándo |
|---|---|---|
| **Mínima** | orchestrator + 1 coder | Prototipos, features simples |
| **Estándar** | orchestrator + coder-backend + coder-frontend | Apps fullstack típicas |
| **Con QA** | orchestrator + 2 coders + reviewer | Proyectos con revisión real |
| **Completa** | todos los 7 roles | Solo si tienes tareas en todos los dominios activas |

Por encima de 4-5 agentes simultáneos activos, el overhead de coordinación empieza a superar el beneficio del paralelismo.

---

## Publicar en npm

```bash
npm login                  # autenticarse con npmjs.org (una sola vez)
npm run release            # build + publish hiveclaude
```

---

## Desarrollo

```bash
npm install                # instalar dependencias de todos los packages
npm run build              # compilar broker + cli
npm test                   # correr todos los tests
npm run dev:broker         # modo watch del broker
```

---

## Licencia

MIT
