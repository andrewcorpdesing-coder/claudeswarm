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
}

export class TaskStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.db.addSchema(TASK_SCHEMA)
    // Migration: add verification column if upgrading from an older DB
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN verification TEXT') } catch { /* already exists */ }
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
           milestone_id, acceptance_criteria, created_by, created_at, last_updated, context)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, params.title, params.description, priority,
        params.assignedRole ?? null, params.assignedTo ?? null,
        params.milestoneId ?? null, params.acceptanceCriteria ?? null,
        params.createdBy, now, now,
        params.context ? JSON.stringify(params.context) : null,
      )

      for (const depId of params.dependsOn ?? []) {
        this.db.prepare(`
          INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)
        `).run(id, depId)
      }
    })

    return this.getById(id)!
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
      ORDER BY t.priority ASC, t.created_at ASC
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
    return this.getById(params.taskId)!
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
    }
  }
}
