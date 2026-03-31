# Hive Mind

**Coordina múltiples instancias de Claude Code para que trabajen juntas en un mismo proyecto.**

Hive Mind es un broker MCP local que conecta varios agentes Claude Code entre sí. Cada agente tiene un rol (orquestador, coder, reviewer, etc.), comparte estado en una pizarra común, se coordina con tareas, bloqueos de archivos y mensajes directos — todo sin salir del terminal.

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

## Por qué usar Hive Mind

### Mejor calidad de código — el reviewer realmente funciona

Un solo agente que implementa y luego "revisa" su propio código es el mismo modelo con el mismo sesgo. El reviewer de Hive Mind es una instancia separada que llega al código sin saber cómo fue construido — igual que un code review real. Detecta cosas distintas porque no cargó la historia de implementación.

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

## Prerequisitos

- **Node.js 22+** (usa `node:sqlite` built-in)
- **Claude Code** instalado (`npm install -g @anthropic-ai/claude-code`)
- **npm 10+**

---

## Instalación

### Opción A — Desde el repositorio (desarrollo local)

```bash
git clone https://github.com/andrewcorpdesing-coder/hivemind
cd hivemind
npm install
npm run build
npm run link:local      # registra 'hive' globalmente via npm link
```

### Opción B — Desde npm (cuando se publique)

```bash
npm install -g @hivemind/cli
```

---

## Quick Start

### Forma rápida — un solo comando

```bash
cd mi-proyecto
hive init
hive run "implementa autenticación JWT"
```

`hive run` arranca el broker, abre terminales para los agentes principales (orchestrator, coder-backend, coder-frontend, reviewer) y encola la tarea en un solo paso. Cada agente empieza solo al presionar Enter en su terminal.

### Forma manual — control total

```bash
# 1. Inicializar en tu proyecto
cd mi-proyecto
hive init

# 2. Arrancar el broker en background
hive start

# 3. Crear directorios de agentes con prompts, hooks MCP y ramas git
hive scaffold

# 4. Abrir terminales por rol
hive exec --launch orchestrator coder-backend reviewer

# 5. El orquestador presentará un plan en su terminal.
#    Cuando esté listo, apruébalo desde cualquier terminal:
hive approve
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
  hive approve  ←── tú desde la CLI
       ↓
crea tareas y notifica a los workers
```

Puedes ver el plan en cualquier momento:

```bash
hive plan            # muestra el plan actual (draft o aprobado)
hive approve         # aprueba el plan — el orquestador empieza a crear tareas
hive reject "texto"  # rechaza con feedback — el orquestador revisa y re-presenta
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
| `hive init [nombre]` | Crea `.hive/` con config, `.mcp.json` en la raíz y modelos por defecto |
| `hive start` | Arranca el broker como daemon (PID en `.hive/broker.pid`) |
| `hive stop` | Para el broker |
| `hive restart [--keep-blackboard]` | Para, limpia estado y arranca de nuevo |
| `hive status` | Estado del broker, agentes online, sesiones activas |
| `hive agents` | Lista agentes conectados con rol y estado |
| `hive tasks [--status <estado>]` | Lista tareas (pending, in\_progress, completed…) |
| `hive prompt <rol> [-i id] [-o path]` | Imprime o guarda el system prompt para un rol |
| `hive scaffold [--force]` | Crea `agents/<rol>/` con CLAUDE.md, .mcp.json, hooks y ramas git. `--force` sobreescribe CLAUDE.md existentes |
| `hive exec [roles…] [--launch] [--yolo]` | Imprime los comandos `claude` a ejecutar por rol (o abre terminales con `--launch`) |
| `hive run [tarea] [--roles roles…] [--yolo]` | Arranca broker + agentes en un solo comando, opcionalmente encolando una tarea |
| `hive task "descripción"` | Encola una tarea para el orquestador sin reiniciar agentes |
| `hive plan` | Muestra el plan actual del orquestador (draft o aprobado) |
| `hive approve` | Aprueba el plan — el orquestador empieza a crear tareas |
| `hive reject "feedback"` | Rechaza el plan con feedback — el orquestador lo revisa |
| `hive cleanup [--db] [--blackboard] [--branches] [--all]` | Resetea estado del broker |

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
hive exec                                                        # usa modelos del config
hive exec orchestrator:opus coder-backend:sonnet reviewer:haiku  # override por rol
hive exec --launch orchestrator coder-backend reviewer           # abre terminales
hive exec --launch --yolo orchestrator coder-backend reviewer    # sin prompts de permisos
```

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
| `hive_create_task` | Orchestrator | Crear tarea con prioridad, dependencias y rol asignado |
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
| `plan_approved` | Orchestrator | El usuario aprobó el plan vía `hive approve` |
| `plan_rejected` | Orchestrator | El usuario rechazó el plan con feedback |
| `new_input` | Orchestrator | Nueva tarea encolada vía `hive task` o `hive run` |

### Pizarra compartida (Blackboard)

Estado JSON compartido persistido en `.hive/blackboard.json`. Estructura:

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

Las tareas completadas por workers pasan a `qa_pending`. El reviewer las inspecciona con `hive_get_pending_reviews` y aprueba o rechaza con `hive_submit_review`. Al aprobar:

- La tarea pasa a `completed`
- El broker desbloquea automáticamente las tareas dependientes
- Los agentes del rol correcto reciben `task_available` y retoman trabajo sin intervención del orquestador
- Si todas las tareas están completadas, el broker emite `sprint_complete` a todos los agentes

Si son rechazadas, vuelven al agente original (`needs_revision`) con feedback específico y accionable.

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

## Monitor en tiempo real

Con el broker corriendo, abre en el navegador:

```
http://localhost:7432/monitor
```

Dashboard con auto-refresh cada 3 segundos — muestra agentes online, tareas con su estado, pizarra compartida, locks activos y audit log. Sin dependencias, sin instalación adicional.

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
POST /admin/input                         — encolar tarea para el orquestador (usado por hive task / hive run)
GET  /admin/plan                          — plan actual del orquestador
POST /admin/plan/approve                  — aprobar plan (usado por hive approve)
POST /admin/plan/reject                   — rechazar plan con feedback (usado por hive reject)
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
npm run release            # build + publish @hivemind/broker y @hivemind/cli
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
