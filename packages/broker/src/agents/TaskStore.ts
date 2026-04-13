import { randomUUID } from 'node:crypto'
import type { Database } from '../db/Database.js'

const TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN (
                        'pending','assigned','in_progress','qa_pending',
                        'qa_phase1_running','qa_phase2_pending','needs_revision',
                        'completed','failed','blocked','cancelled'
                      )),
  priority            INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 4),
  assigned_role       TEXT,
  assigned_to         TEXT,
  milestone_id        TEXT,
  acceptance_criteria TEXT,
  notes_for_reviewer  TEXT,
  files_modified      TEXT,
  test_results        TEXT,
  verification        TEXT,
  completion_summary  TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at         TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  last_updated        TEXT NOT NULL DEFAULT (datetime('now')),
  context             TEXT,
  qa_phase1_output    TEXT,
  qa_phase2_verdict   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks(priority);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on_id);

CREATE TABLE IF NOT EXISTS task_progress (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL,
  status           TEXT NOT NULL,
  summary          TEXT,
  percent_complete INTEGER,
  blocking_reason  TEXT,
  recorded_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_progress_task ON task_progress(task_id);
`

interface TaskRow {
  id: string
  title: string
  description: string
  status: string
  priority: number
  assigned_role: string | null
  assigned_to: string | null
  milestone_id: string | null
  acceptance_criteria: string | null
  notes_for_reviewer: string | null
  files_modified: string | null
  test_results: string | null
  verification: string | null
  completion_summary: string | null
  created_by: string
  created_at: string
  assigned_at: string | null
  started_at: string | null
  completed_at: string | null
  last_updated: string
  context: string | null
  qa_phase1_output: string | null
  qa_phase2_verdict: string | null
  // v0.2 fields
  task_type: string | null
  decay_score: number
  quality_floor: number
  estimated_ms: number | null
  // CPM fields
  estimated_duration: number
  float_minutes: number | null
  is_critical_path: number
}

export interface TaskRecord {
  id: string
  title: string
  description: string
  status: string
  priority: number
  assignedRole: string | null
  assignedTo: string | null
  milestoneId: string | null
  acceptanceCriteria: string | null
  notesForReviewer: string | null
  filesModified: string[] | null
  testResults: Record<string, unknown> | null
  verification: { method: string; passed: boolean; evidence: string } | null
  completionSummary: string | null
  createdBy: string
  createdAt: string
  assignedAt: string | null
  startedAt: string | null
  completedAt: string | null
  lastUpdated: string
  context: Record<string, unknown> | null
  dependsOn: string[]
  // v0.2 fields
  taskType: string | null
  decayScore: number
  qualityFloor: number
  estimatedMs: number | null
  // CPM fields
  estimatedDuration: number
  floatMinutes: number | null
  isCriticalPath: boolean
}

export class TaskStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.db.addSchema(TASK_SCHEMA)
    // Migrations — additive only, safe to re-run
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN verification TEXT') } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT NULL") } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN decay_score REAL DEFAULT 0.5') } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN quality_floor REAL DEFAULT 0.0') } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN estimated_ms INTEGER DEFAULT NULL') } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN estimated_duration INTEGER DEFAULT 60') } catch { }
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN float_minutes INTEGER') } catch { }
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN is_critical_path INTEGER DEFAULT 0') } catch { }
    // agent_quality table for Thompson Sampling
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_quality (
        agent_id   TEXT NOT NULL,
        task_type  TEXT NOT NULL,
        alpha      REAL NOT NULL DEFAULT 1.0,
        beta       REAL NOT NULL DEFAULT 1.0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, task_type)
      )
    `)
    // task_completion_records for CriticalityEngine
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_completion_records (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL,
        agent_role   TEXT NOT NULL,
        task_type    TEXT,
        estimated_ms INTEGER,
        actual_ms    INTEGER,
        review_score REAL,
        completed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }

  create(params: {
    title: string
    description: string
    createdBy: string
    assignedRole?: string
    assignedTo?: string
    priority?: number
    milestoneId?: string
    acceptanceCriteria?: string
    dependsOn?: string[]
    context?: Record<string, unknown>
    taskType?: string
    estimatedMs?: number
    estimatedDuration?: number  // minutos, default 60
  }): TaskRecord {
    const id = randomUUID()
    const now = new Date().toISOString()
    const priority = params.priority ?? 3

    // Validate all depends_on task IDs exist
    for (const depId of params.dependsOn ?? []) {
      const exists = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(depId)
      if (!exists) throw new Error(`Dependency task not found: ${depId}`)
    }

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks
          (id, title, description, status, priority, assigned_role, assigned_to,
           milestone_id, acceptance_criteria, created_by, created_at, last_updated, context,
           task_type, estimated_ms, estimated_duration)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, params.title, params.description, priority,
        params.assignedRole ?? null, params.assignedTo ?? null,
        params.milestoneId ?? null, params.acceptanceCriteria ?? null,
        params.createdBy, now, now,
        params.context ? JSON.stringify(params.context) : null,
        params.taskType ?? null,
        params.estimatedMs ?? null,
        params.estimatedDuration ?? 60,
      )

      for (const depId of params.dependsOn ?? []) {
        this.db.prepare(`
          INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)
        `).run(id, depId)
      }
    })

    const result = this.getById(id)!
    this.computeCPM()
    return result
  }

  /**
   * Returns the highest-priority available task for a given role.
   * A task is "available" when: status='pending' AND all dependencies are 'completed'.
   */
  getNextAvailable(role: string): TaskRecord | null {
    const row = this.db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status = 'pending'
        AND (t.assigned_role IS NULL OR t.assigned_role = ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON td.depends_on_id = dep.id
          WHERE td.task_id = t.id
            AND dep.status != 'completed'
        )
      ORDER BY t.is_critical_path DESC,
               COALESCE(t.float_minutes, 9999) ASC,
               t.priority ASC,
               t.created_at ASC
      LIMIT 1
    `).get(role) as TaskRow | undefined

    return row ? this.rowToRecord(row) : null
  }

  assign(taskId: string, agentId: string): TaskRecord {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE tasks SET status = 'assigned', assigned_to = ?, assigned_at = ?, last_updated = ?
      WHERE id = ?
    `).run(agentId, now, now, taskId)
    return this.getById(taskId)!
  }

  startProgress(taskId: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE tasks SET status = 'in_progress', started_at = ?, last_updated = ?
      WHERE id = ? AND status = 'assigned'
    `).run(now, now, taskId)
  }

  addProgress(params: {
    taskId: string
    agentId: string
    status: string
    summary: string
    percentComplete?: number
    blockingReason?: string
  }): void {
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO task_progress (task_id, agent_id, status, summary, percent_complete, blocking_reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.taskId, params.agentId, params.status, params.summary,
      params.percentComplete ?? null, params.blockingReason ?? null, now,
    )

    // Update task status if blocked
    const newStatus = params.status === 'blocked' ? 'blocked' : 'in_progress'
    this.db.prepare(`
      UPDATE tasks SET status = ?, last_updated = ? WHERE id = ?
    `).run(newStatus, now, params.taskId)
  }

  complete(params: {
    taskId: string
    agentId: string
    summary: string
    filesModified?: string[]
    testResults?: Record<string, unknown>
    verification?: { method: string; passed: boolean; evidence: string }
    notesForReviewer?: string
  }): TaskRecord {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE tasks SET
        status = 'qa_pending',
        completion_summary = ?,
        files_modified = ?,
        test_results = ?,
        verification = ?,
        notes_for_reviewer = ?,
        completed_at = ?,
        last_updated = ?
      WHERE id = ?
    `).run(
      params.summary,
      params.filesModified ? JSON.stringify(params.filesModified) : null,
      params.testResults ? JSON.stringify(params.testResults) : null,
      params.verification ? JSON.stringify(params.verification) : null,
      params.notesForReviewer ?? null,
      now, now,
      params.taskId,
    )
    return this.getById(params.taskId)!
  }

  /**
   * Reviewer approves a qa_pending task → completed.
   * Returns the updated task.
   */
  approve(params: {
    taskId: string
    reviewerId: string
    feedback?: string
  }): TaskRecord {
    const now = new Date().toISOString()
    const verdict = JSON.stringify({ verdict: 'approved', reviewedBy: params.reviewerId, feedback: params.feedback ?? null, reviewedAt: now })
    this.db.prepare(`
      UPDATE tasks SET status = 'completed', qa_phase2_verdict = ?, completed_at = ?, last_updated = ?
      WHERE id = ?
    `).run(verdict, now, now, params.taskId)
    const result = this.getById(params.taskId)!
    this.computeCPM()
    return result
  }

  /**
   * Reviewer rejects a qa_pending task → needs_revision.
   * Returns the updated task.
   */
  reject(params: {
    taskId: string
    reviewerId: string
    feedback: string
  }): TaskRecord {
    const now = new Date().toISOString()
    const verdict = JSON.stringify({ verdict: 'rejected', reviewedBy: params.reviewerId, feedback: params.feedback, reviewedAt: now })
    this.db.prepare(`
      UPDATE tasks SET status = 'needs_revision', qa_phase2_verdict = ?, last_updated = ?
      WHERE id = ?
    `).run(verdict, now, params.taskId)
    return this.getById(params.taskId)!
  }

  /**
   * Returns a needs_revision task assigned to this agent, if any.
   * Called before getNextAvailable so agents handle revisions first.
   */
  getRevisionTask(agentId: string): TaskRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM tasks WHERE status = 'needs_revision' AND assigned_to = ?
      ORDER BY priority ASC, last_updated ASC LIMIT 1
    `).get(agentId) as TaskRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  /** Bypass QA — mark directly completed (used in tests / admin) */
  forceComplete(taskId: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE tasks SET status = 'completed', completed_at = ?, last_updated = ?
      WHERE id = ?
    `).run(now, now, taskId)
  }

  getById(taskId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    return row ? this.rowToRecord(row) : null
  }

  listByStatus(status: string): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC').all(status) as unknown as TaskRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  listAll(): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY priority ASC, created_at ASC').all() as unknown as TaskRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  listForAgent(agentId: string): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks WHERE assigned_to = ? ORDER BY priority ASC, created_at ASC
    `).all(agentId) as unknown as TaskRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  /**
   * Returns tasks that were blocked on completedTaskId and are now fully unblocked.
   * A task is unblocked when all its dependencies are 'completed'.
   */
  getNewlyUnblockedTasks(completedTaskId: string): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      JOIN task_dependencies td ON td.task_id = t.id
      WHERE td.depends_on_id = ?
        AND t.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td2
          JOIN tasks dep ON td2.depends_on_id = dep.id
          WHERE td2.task_id = t.id
            AND dep.status != 'completed'
        )
    `).all(completedTaskId) as unknown as TaskRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  /** Returns true when every task in the store is completed (or there are none). */
  allCompleted(): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as done
      FROM tasks
    `).get() as { total: number; done: number }
    return row.total > 0 && row.total === row.done
  }

  private getDependencies(taskId: string): string[] {
    const rows = this.db.prepare(
      'SELECT depends_on_id FROM task_dependencies WHERE task_id = ?',
    ).all(taskId) as unknown as Array<{ depends_on_id: string }>
    return rows.map(r => r.depends_on_id)
  }

  // ── v0.2 helpers ────────────────────────────────────────────────────────────

  setDecayScore(taskId: string, score: number): void {
    this.db.prepare('UPDATE tasks SET decay_score = ?, last_updated = ? WHERE id = ?')
      .run(score, new Date().toISOString(), taskId)
  }

  setQualityFloor(taskId: string, floor: number): void {
    this.db.prepare('UPDATE tasks SET quality_floor = ?, last_updated = ? WHERE id = ?')
      .run(floor, new Date().toISOString(), taskId)
  }

  /** Top N pending tasks for a role ordered by decay_score DESC — for Thompson sampling */
  getTopCandidates(role: string, limit = 5): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status = 'pending'
        AND (t.assigned_role IS NULL OR t.assigned_role = ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON td.depends_on_id = dep.id
          WHERE td.task_id = t.id AND dep.status != 'completed'
        )
      ORDER BY t.decay_score DESC, t.priority ASC, t.created_at ASC
      LIMIT ?
    `).all(role, limit) as unknown as TaskRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  /** Pending/in_progress tasks that declared any of the given files */
  getPendingTasksWithFiles(filePaths: string[]): TaskRecord[] {
    if (filePaths.length === 0) return []
    const active = [
      ...this.listByStatus('pending'),
      ...this.listByStatus('in_progress'),
      ...this.listByStatus('assigned'),
    ]
    const pathSet = new Set(filePaths)
    return active.filter(t => t.filesModified?.some(f => pathSet.has(f)))
  }

  /** Recent completion records for CriticalityEngine */
  getRecentCompletionRecords(limit = 50): Array<{
    agentRole: string; taskType: string | null
    estimatedMs: number | null; actualMs: number | null
    reviewScore: number | null; completedAt: string
  }> {
    const rows = this.db.prepare(`
      SELECT agent_role   AS agentRole,
             task_type    AS taskType,
             estimated_ms AS estimatedMs,
             actual_ms    AS actualMs,
             review_score AS reviewScore,
             completed_at AS completedAt
      FROM task_completion_records ORDER BY completed_at DESC LIMIT ?
    `).all(limit) as unknown as Array<{
      agentRole: string; taskType: string | null
      estimatedMs: number | null; actualMs: number | null
      reviewScore: number | null; completedAt: string
    }>
    return rows
  }

  /** Log a completion record (called from completeTaskTool) */
  logCompletion(params: {
    taskId: string; agentRole: string; taskType: string | null
    estimatedMs: number | null; actualMs: number | null
  }): void {
    this.db.prepare(`
      INSERT INTO task_completion_records (task_id, agent_role, task_type, estimated_ms, actual_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(params.taskId, params.agentRole, params.taskType, params.estimatedMs, params.actualMs)
  }

  /** Update review_score on a completion record after QA */
  updateCompletionScore(taskId: string, score: number): void {
    this.db.prepare(`
      UPDATE task_completion_records SET review_score = ? WHERE task_id = ?
    `).run(score, taskId)
  }

  /** Recent reviews for FEP quality_trend probe */
  getRecentReviews(limit = 10): Array<{ approved: boolean }> {
    const rows = this.db.prepare(`
      SELECT qa_phase2_verdict FROM tasks
      WHERE qa_phase2_verdict IS NOT NULL
      ORDER BY last_updated DESC LIMIT ?
    `).all(limit) as unknown as Array<{ qa_phase2_verdict: string }>
    return rows.map(r => {
      const v = JSON.parse(r.qa_phase2_verdict) as { verdict: string }
      return { approved: v.verdict === 'approved' }
    })
  }

  /** Count of tasks currently in 'blocked' status (FEP critical_path_health probe). */
  getBlockingTaskCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE status = 'blocked'"
    ).get() as { n: number }
    return row.n
  }

  /** In-progress tasks for FEP context_budget probe */
  getInProgressByAgent(agentId: string): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks WHERE status = 'in_progress' AND assigned_to = ?
    `).all(agentId) as unknown as TaskRow[]
    return rows.map(r => this.rowToRecord(r))
  }

  // ── Gap 1: dependency management ─────────────────────────────────────────

  /**
   * Add a dependency after task creation.
   * Validates: both tasks exist, no self-reference, no cycle.
   * Error codes: TASK_NOT_FOUND, SELF_REFERENCE, WOULD_CREATE_CYCLE, ALREADY_EXISTS
   */
  addDependency(taskId: string, dependsOnId: string): { ok: true } | { ok: false; code: string; reason: string } {
    if (taskId === dependsOnId) {
      return { ok: false, code: 'SELF_REFERENCE', reason: 'A task cannot depend on itself' }
    }
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as { id: string } | undefined
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', reason: `Task not found: ${taskId}` }
    const dep = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(dependsOnId) as { id: string } | undefined
    if (!dep) return { ok: false, code: 'TASK_NOT_FOUND', reason: `Dependency task not found: ${dependsOnId}` }

    // Check if already exists
    const existing = this.db.prepare(
      'SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?'
    ).get(taskId, dependsOnId)
    if (existing) return { ok: false, code: 'ALREADY_EXISTS', reason: 'Dependency already exists' }

    if (this.wouldCreateCycle(taskId, dependsOnId)) {
      return { ok: false, code: 'WOULD_CREATE_CYCLE', reason: 'Adding this dependency would create a cycle' }
    }

    this.db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId)
    return { ok: true }
  }

  /**
   * Check if adding edge taskId→newDepId would create a cycle.
   * Uses BFS forward from newDepId — if we can reach taskId from newDepId,
   * the new edge would close a cycle.
   */
  wouldCreateCycle(taskId: string, newDepId: string): boolean {
    // BFS: start from newDepId, follow "task_id depends_on depends_on_id"
    // i.e., forward = "what tasks does newDepId depend on (transitively)"
    // If we reach taskId, adding taskId→newDepId creates a cycle
    const visited = new Set<string>()
    const queue = [newDepId]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current === taskId) return true
      if (visited.has(current)) continue
      visited.add(current)
      const deps = this.db.prepare(
        'SELECT depends_on_id FROM task_dependencies WHERE task_id = ?'
      ).all(current) as Array<{ depends_on_id: string }>
      for (const d of deps) queue.push(d.depends_on_id)
    }
    return false
  }

  /**
   * CPM: count blocked tasks on the critical path (Float = 0).
   * Falls back to getBlockingTaskCount() if there are no estimated_ms.
   *
   * Algorithm:
   * 1. Get all active (pending + in_progress + blocked) tasks with estimates
   * 2. Topological sort via Kahn's on task_dependencies
   * 3. Compute ES/EF (forward pass), LS/LF (backward pass)
   * 4. Float = LS - ES; Float=0 → on critical path
   * 5. Return count of 'blocked' tasks where Float=0
   */
  getCriticalPathBlockedCount(): number {
    const activeStatuses = ['pending', 'assigned', 'in_progress', 'blocked']
    const rows = this.db.prepare(`
      SELECT id, status, estimated_ms FROM tasks WHERE status IN (${activeStatuses.map(() => '?').join(',')})
    `).all(...activeStatuses) as Array<{ id: string; status: string; estimated_ms: number | null }>

    if (rows.length === 0) return 0

    const taskIds = new Set(rows.map(r => r.id))
    const deps = this.db.prepare(`
      SELECT task_id, depends_on_id FROM task_dependencies
      WHERE task_id IN (${rows.map(() => '?').join(',')})
        AND depends_on_id IN (${rows.map(() => '?').join(',')})
    `).all(...rows.map(r => r.id), ...rows.map(r => r.id)) as Array<{ task_id: string; depends_on_id: string }>

    // Estimate in minutes (fallback: average of known estimates, or 60 min)
    const knownEstimates = rows.filter(r => r.estimated_ms != null).map(r => r.estimated_ms! / 60_000)
    const avgEstimate = knownEstimates.length > 0
      ? knownEstimates.reduce((a, b) => a + b, 0) / knownEstimates.length
      : 60

    const duration = (id: string): number => {
      const r = rows.find(t => t.id === id)
      return r?.estimated_ms != null ? r.estimated_ms / 60_000 : avgEstimate
    }

    // Build adjacency (predecessors and successors)
    const successors = new Map<string, string[]>()
    const inDegree   = new Map<string, number>()
    for (const r of rows) { successors.set(r.id, []); inDegree.set(r.id, 0) }
    for (const d of deps) {
      successors.get(d.depends_on_id)!.push(d.task_id)
      inDegree.set(d.task_id, (inDegree.get(d.task_id) ?? 0) + 1)
    }

    // Kahn's topological sort
    const topo: string[] = []
    const queue = [...rows.filter(r => (inDegree.get(r.id) ?? 0) === 0).map(r => r.id)]
    while (queue.length > 0) {
      const node = queue.shift()!
      topo.push(node)
      for (const succ of successors.get(node) ?? []) {
        const deg = (inDegree.get(succ) ?? 1) - 1
        inDegree.set(succ, deg)
        if (deg === 0) queue.push(succ)
      }
    }

    // If cycle detected (shouldn't happen with our cycle check), fall back
    if (topo.length < rows.length) return this.getBlockingTaskCount()

    // Forward pass: ES, EF
    const ES = new Map<string, number>()
    const EF = new Map<string, number>()
    for (const id of topo) {
      const predecessors = deps.filter(d => d.task_id === id).map(d => d.depends_on_id)
      const es = predecessors.length > 0
        ? Math.max(...predecessors.map(p => EF.get(p) ?? 0))
        : 0
      ES.set(id, es)
      EF.set(id, es + duration(id))
    }

    const projectDuration = Math.max(...[...EF.values()])

    // Backward pass: LF, LS
    const LF = new Map<string, number>()
    const LS = new Map<string, number>()
    for (const id of [...topo].reverse()) {
      const succs = successors.get(id) ?? []
      const lf = succs.length > 0
        ? Math.min(...succs.map(s => LS.get(s) ?? projectDuration))
        : projectDuration
      LF.set(id, lf)
      LS.set(id, lf - duration(id))
    }

    // Count blocked tasks on critical path (Float = LS - ES ≈ 0)
    let count = 0
    for (const r of rows) {
      if (r.status === 'blocked') {
        const float = (LS.get(r.id) ?? 0) - (ES.get(r.id) ?? 0)
        if (Math.abs(float) < 0.001) count++
      }
    }
    return count
  }

  // ── CPM ──────────────────────────────────────────────────────────────────────

  computeCPM(): void {
    // 1. Cargar tareas activas (no completadas/canceladas)
    const activeTasks = this.db.prepare(`
      SELECT id, estimated_duration FROM tasks
      WHERE status NOT IN ('completed', 'cancelled', 'failed')
    `).all() as Array<{ id: string; estimated_duration: number }>

    if (activeTasks.length === 0) return

    const taskIds = new Set(activeTasks.map(t => t.id))
    const duration = new Map(activeTasks.map(t => [t.id, t.estimated_duration]))

    // 2. Dependencias entre tareas activas únicamente
    const allDeps = this.db.prepare(`
      SELECT td.task_id, td.depends_on_id
      FROM task_dependencies td
      JOIN tasks dep ON td.depends_on_id = dep.id
      WHERE dep.status NOT IN ('completed', 'cancelled', 'failed')
        AND td.task_id IN (
          SELECT id FROM tasks WHERE status NOT IN ('completed', 'cancelled', 'failed')
        )
    `).all() as Array<{ task_id: string; depends_on_id: string }>

    // 3. Construir grafo
    const predecessors = new Map<string, string[]>()
    const successors = new Map<string, string[]>()
    for (const t of activeTasks) {
      predecessors.set(t.id, [])
      successors.set(t.id, [])
    }
    for (const dep of allDeps) {
      if (taskIds.has(dep.depends_on_id)) {
        predecessors.get(dep.task_id)!.push(dep.depends_on_id)
        successors.get(dep.depends_on_id)!.push(dep.task_id)
      }
    }

    // 4. Topological sort (Kahn's algorithm)
    const inDegree = new Map(activeTasks.map(t => [t.id, predecessors.get(t.id)!.length]))
    const queue = activeTasks.filter(t => inDegree.get(t.id) === 0).map(t => t.id)
    const topoOrder: string[] = []
    while (queue.length > 0) {
      const curr = queue.shift()!
      topoOrder.push(curr)
      for (const succ of successors.get(curr)!) {
        const deg = inDegree.get(succ)! - 1
        inDegree.set(succ, deg)
        if (deg === 0) queue.push(succ)
      }
    }

    // 5. Forward pass (Early Start / Early Finish)
    const ES = new Map<string, number>()
    const EF = new Map<string, number>()
    for (const id of topoOrder) {
      const preds = predecessors.get(id)!
      const es = preds.length === 0 ? 0 : Math.max(...preds.map(p => EF.get(p)!))
      ES.set(id, es)
      EF.set(id, es + duration.get(id)!)
    }

    // 6. Backward pass (Late Start / Late Finish)
    const projectEnd = Math.max(...[...EF.values()])
    const LS = new Map<string, number>()
    const LF = new Map<string, number>()
    for (const id of [...topoOrder].reverse()) {
      const succs = successors.get(id)!
      const lf = succs.length === 0 ? projectEnd : Math.min(...succs.map(s => LS.get(s)!))
      LF.set(id, lf)
      LS.set(id, lf - duration.get(id)!)
    }

    // 7. Calcular float y critical path, actualizar DB
    this.db.transaction(() => {
      for (const id of topoOrder) {
        const float = LS.get(id)! - ES.get(id)!
        const isCritical = float <= 0 ? 1 : 0
        this.db.prepare(
          'UPDATE tasks SET float_minutes = ?, is_critical_path = ? WHERE id = ?'
        ).run(float, isCritical, id)
      }
    })
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private rowToRecord(row: TaskRow): TaskRecord {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignedRole: row.assigned_role,
      assignedTo: row.assigned_to,
      milestoneId: row.milestone_id,
      acceptanceCriteria: row.acceptance_criteria,
      notesForReviewer: row.notes_for_reviewer,
      filesModified: row.files_modified ? JSON.parse(row.files_modified) as string[] : null,
      testResults: row.test_results ? JSON.parse(row.test_results) as Record<string, unknown> : null,
      verification: row.verification ? JSON.parse(row.verification) as { method: string; passed: boolean; evidence: string } : null,
      completionSummary: row.completion_summary,
      createdBy: row.created_by,
      createdAt: row.created_at,
      assignedAt: row.assigned_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastUpdated: row.last_updated,
      context: row.context ? JSON.parse(row.context) as Record<string, unknown> : null,
      dependsOn: this.getDependencies(row.id),
      taskType: row.task_type ?? null,
      decayScore: row.decay_score ?? 0.5,
      qualityFloor: row.quality_floor ?? 0.0,
      estimatedMs: row.estimated_ms ?? null,
      estimatedDuration: row.estimated_duration ?? 60,
      floatMinutes: row.float_minutes ?? null,
      isCriticalPath: row.is_critical_path === 1,
    }
  }
}
