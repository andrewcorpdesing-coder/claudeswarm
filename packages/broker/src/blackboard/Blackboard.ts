import fs from 'node:fs'
import path from 'node:path'
import { BlackboardPermissions } from './BlackboardPermissions.js'
import type { WriteOp, PermissionResult } from './BlackboardPermissions.js'

const DEFAULT_STATE = {
  project: { meta: {}, architecture: {}, conventions: {} },
  knowledge: { discoveries: [], warnings: [], external_apis: {}, session_log: [] },
  state: { sprint: null, blockers: [], milestones: {} },
  agents: {},
  qa: { findings: [], metrics: {}, pending_review: [] },
}

export class Blackboard {
  private data: Record<string, unknown>
  private filePath: string
  private permissions: BlackboardPermissions

  constructor(storageDir = '.hive') {
    this.filePath = path.join(storageDir, 'blackboard.json')
    this.permissions = new BlackboardPermissions()
    this.data = this.load()
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  read(agentRole: string, dotPath: string): { ok: boolean; value?: unknown; reason?: string } {
    if (!this.permissions.canRead(agentRole, dotPath)) {
      return { ok: false, reason: `Read denied: ${dotPath}` }
    }
    return { ok: true, value: this.getAt(dotPath) }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  write(
    agentId: string,
    agentRole: string,
    dotPath: string,
    value: unknown,
    operation: WriteOp,
  ): PermissionResult & { saved?: boolean } {
    const perm = this.permissions.canWrite(agentId, agentRole, dotPath, operation)
    if (!perm.allowed) return perm

    this.applyOperation(dotPath, value, operation)
    this.persist()
    return { ...perm, saved: true }
  }

  // ── Internal write (no permission check — broker use only) ──────────────

  seed(dotPath: string, value: unknown): void {
    this.applyOperation(dotPath, value, 'merge')
    this.persist()
  }

  // ── Raw read (no permission check — for tests and internal use) ───────────

  getAt(dotPath: string): unknown {
    const keys = dotPath.split('.')
    let node: unknown = this.data
    for (const key of keys) {
      if (node == null || typeof node !== 'object') return undefined
      node = (node as Record<string, unknown>)[key]
    }
    return node
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.data))
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private applyOperation(dotPath: string, value: unknown, operation: WriteOp): void {
    const keys = dotPath.split('.')
    const last = keys.pop()!
    let node: unknown = this.data

    for (const key of keys) {
      if (node == null || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n[key] == null) n[key] = {}
      node = n[key]
    }

    if (node == null || typeof node !== 'object') return
    const target = node as Record<string, unknown>

    if (operation === 'set') {
      target[last] = value
      return
    }

    if (operation === 'append') {
      const existing = target[last]
      if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        target[last] = [value]
      }
      return
    }

    if (operation === 'merge') {
      const existing = target[last]
      if (existing != null && typeof existing === 'object' && !Array.isArray(existing) &&
          value != null && typeof value === 'object' && !Array.isArray(value)) {
        target[last] = { ...(existing as object), ...(value as object) }
      } else {
        target[last] = value
      }
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const json = JSON.stringify(this.data, null, 2)
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, json, 'utf8')
    try {
      fs.renameSync(tmp, this.filePath)
    } catch {
      // Fallback for Windows (EPERM when destination is locked by another process)
      fs.writeFileSync(this.filePath, json, 'utf8')
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  private load(): Record<string, unknown> {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8')
        return JSON.parse(raw) as Record<string, unknown>
      }
    } catch {
      // corrupt file → start fresh
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE))
  }
}
