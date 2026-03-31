import http from 'node:http'
import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Database } from '../db/Database.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import { TaskStore } from '../agents/TaskStore.js'
import { FileLockRegistry } from '../agents/FileLockRegistry.js'
import { EventQueue } from './EventQueue.js'
import { MessageBus } from './MessageBus.js'
import { registerRegisterTool } from '../tools/registerTool.js'
import { registerHeartbeatTool } from '../tools/heartbeatTool.js'
import { registerWaitTool } from '../tools/waitTool.js'
import { registerSendTool } from '../tools/sendTool.js'
import { registerListAgentsTool } from '../tools/listAgentsTool.js'
import { registerCreateTaskTool } from '../tools/createTaskTool.js'
import { registerGetNextTaskTool } from '../tools/getNextTaskTool.js'
import { registerUpdateTaskProgressTool } from '../tools/updateTaskProgressTool.js'
import { registerCompleteTaskTool } from '../tools/completeTaskTool.js'
import { registerGetTaskTool } from '../tools/getTaskTool.js'
import { registerListTasksTool } from '../tools/listTasksTool.js'
import { registerDeclareLocksToolTool } from '../tools/declareLocksTool.js'
import { registerRequestLockTool } from '../tools/requestLockTool.js'
import { registerReleaseLocksToolTool } from '../tools/releaseLocksTool.js'
import { Blackboard } from '../blackboard/Blackboard.js'
import { registerBlackboardReadTool } from '../tools/blackboardReadTool.js'
import { registerBlackboardWriteTool } from '../tools/blackboardWriteTool.js'
import { AuditLedger } from '../audit/AuditLedger.js'
import { registerAuditLogTool } from '../tools/auditLogTool.js'
import { registerGetPendingReviewsTool } from '../tools/getPendingReviewsTool.js'
import { registerSubmitReviewTool } from '../tools/submitReviewTool.js'
import { registerEndSessionTool } from '../tools/endSessionTool.js'
import { registerMergeBranchTool } from '../tools/mergeBranchTool.js'

export interface HiveSession {
  sessionId: string
  agentId: string | null
}

export interface SseSession extends HiveSession {
  transport: SSEServerTransport
  mcpServer: McpServer
  connectedAt: Date
}

export interface StreamableSession extends HiveSession {
  transport: StreamableHTTPServerTransport
  mcpServer: McpServer
  connectedAt: Date
}

export interface HttpServerOptions {
  db: Database
  agentRegistry: AgentRegistry
  port: number
  blackboardDir?: string   // defaults to '.hive'
}

export class HttpServer {
  private httpServer: http.Server
  private sessions = new Map<string, SseSession>()
  private streamableSessions = new Map<string, StreamableSession>()
  private allSessions = new Map<string, HiveSession>()
  private eventQueue: EventQueue
  private messageBus: MessageBus
  private taskStore: TaskStore
  private fileLockRegistry: FileLockRegistry
  private blackboard: Blackboard
  private auditLedger: AuditLedger
  private agentRegistry: AgentRegistry
  private port: number

  constructor(opts: HttpServerOptions) {
    this.agentRegistry = opts.agentRegistry
    this.eventQueue = new EventQueue()
    this.messageBus = new MessageBus(opts.db)
    this.taskStore = new TaskStore(opts.db)
    this.fileLockRegistry = new FileLockRegistry(opts.db)
    this.blackboard = new Blackboard(opts.blackboardDir)
    this.auditLedger = new AuditLedger(opts.db)
    this.port = opts.port

    // Release file locks when an agent goes offline (disconnect or stale heartbeat)
    this.agentRegistry.setOnOfflineCallback((agentId) => {
      const promoted = this.fileLockRegistry.releaseAllForAgent(agentId)
      for (const p of promoted) {
        this.eventQueue.push(p.agentId, 'lock_granted', {
          filePath: p.filePath,
          lockType: p.lockType,
          grantedAt: new Date().toISOString(),
          reason: 'previous_holder_went_offline',
        })
      }
    })

    this.httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res)
    })
  }

  getEventQueue(): EventQueue {
    return this.eventQueue
  }

  getMessageBus(): MessageBus {
    return this.messageBus
  }

  getTaskStore(): TaskStore {
    return this.taskStore
  }

  getFileLockRegistry(): FileLockRegistry {
    return this.fileLockRegistry
  }

  getBlackboard(): Blackboard {
    return this.blackboard
  }

  getAuditLedger(): AuditLedger {
    return this.auditLedger
  }

  getSessions(): Map<string, SseSession> {
    return this.sessions
  }

  getStreamableSessions(): Map<string, StreamableSession> {
    return this.streamableSessions
  }

  getAllSessions(): Map<string, HiveSession> {
    return this.allSessions
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)

    // ── Monitor UI ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/monitor') {
      const html = fs.readFileSync(resolve(__dirname, '../monitor.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // ── Health check ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        message: 'Hive Mind broker',
        version: '0.1.0',
        agents_online: this.agentRegistry.countOnline(),
        sessions: this.sessions.size + this.streamableSessions.size,
      }))
      return
    }

    // ── Admin API ───────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/admin')) {
      await this.handleAdminRequest(req, res, url)
      return
    }

    // ── Streamable HTTP (MCP 2025-03-26 recommended) ───────────────────────
    if (url.pathname === '/mcp') {
      await this.handleMcpRequest(req, res)
      return
    }

    // ── SSE connection (legacy, still supported) ────────────────────────────
    if (req.method === 'GET' && url.pathname === '/sse') {
      await this.handleSseConnection(req, res)
      return
    }

    // ── MCP message for SSE sessions ────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/message') {
      await this.handleMessage(req, res, url)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  private adminJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(payload)
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += String(chunk) })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  private async handleAdminRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const path = url.pathname          // e.g. /admin/tasks/abc-123/force-complete
    const segments = path.split('/').filter(Boolean)  // ['admin', 'tasks', 'abc-123', 'force-complete']
    const resource = segments[1]       // 'agents' | 'tasks' | 'locks' | 'blackboard' | 'audit'
    const resourceId = segments[2]     // optional id
    const action = segments[3]         // optional sub-action

    try {
      // ── GET /admin/agents ─────────────────────────────────────────────────
      if (req.method === 'GET' && resource === 'agents' && !resourceId) {
        const statusFilter = url.searchParams.get('status')
        const agents = statusFilter === 'online'
          ? this.agentRegistry.getOnline()
          : this.agentRegistry.getAll()
        return this.adminJson(res, 200, { count: agents.length, agents })
      }

      // ── DELETE /admin/agents/:id ──────────────────────────────────────────
      if (req.method === 'DELETE' && resource === 'agents' && resourceId) {
        const agent = this.agentRegistry.getById(resourceId)
        if (!agent) return this.adminJson(res, 404, { error: `Agent not found: ${resourceId}` })
        this.agentRegistry.markOffline(resourceId)
        return this.adminJson(res, 200, { ok: true, agentId: resourceId, status: 'offline' })
      }

      // ── POST /admin/agents/:id/heartbeat ──────────────────────────────────
      // Called by PostToolUse hook scripts to keep agent + locks alive
      if (req.method === 'POST' && resource === 'agents' && resourceId && action === 'heartbeat') {
        const agent = this.agentRegistry.getById(resourceId)
        if (!agent) return this.adminJson(res, 404, { error: `Agent not found: ${resourceId}` })
        this.agentRegistry.heartbeat(resourceId)
        this.fileLockRegistry.refreshHeartbeat(resourceId)
        return this.adminJson(res, 200, { ok: true })
      }

      // ── GET /admin/tasks ──────────────────────────────────────────────────
      if (req.method === 'GET' && resource === 'tasks' && !resourceId) {
        const statusFilter = url.searchParams.get('status')
        const tasks = statusFilter
          ? this.taskStore.listByStatus(statusFilter)
          : this.taskStore.listAll()
        return this.adminJson(res, 200, { count: tasks.length, tasks })
      }

      // ── GET /admin/tasks/:id ──────────────────────────────────────────────
      if (req.method === 'GET' && resource === 'tasks' && resourceId && !action) {
        const task = this.taskStore.getById(resourceId)
        if (!task) return this.adminJson(res, 404, { error: `Task not found: ${resourceId}` })
        return this.adminJson(res, 200, task)
      }

      // ── POST /admin/tasks/:id/force-complete ──────────────────────────────
      if (req.method === 'POST' && resource === 'tasks' && resourceId && action === 'force-complete') {
        const task = this.taskStore.getById(resourceId)
        if (!task) return this.adminJson(res, 404, { error: `Task not found: ${resourceId}` })
        this.taskStore.forceComplete(resourceId)
        return this.adminJson(res, 200, { ok: true, taskId: resourceId, status: 'completed' })
      }

      // ── GET /admin/locks ──────────────────────────────────────────────────
      if (req.method === 'GET' && resource === 'locks') {
        const active = this.fileLockRegistry.getAllLocks()
        const queued = this.fileLockRegistry.getAllQueued()
        return this.adminJson(res, 200, {
          active: { count: active.length, locks: active },
          queued: { count: queued.length, locks: queued },
        })
      }

      // ── GET /admin/blackboard ─────────────────────────────────────────────
      if (req.method === 'GET' && resource === 'blackboard') {
        return this.adminJson(res, 200, this.blackboard.snapshot())
      }

      // ── GET /admin/audit ──────────────────────────────────────────────────
      if (req.method === 'GET' && resource === 'audit') {
        const rows = this.auditLedger.query({
          agentId: url.searchParams.get('agent_id') ?? undefined,
          action: url.searchParams.get('action') ?? undefined,
          result: (url.searchParams.get('result') ?? undefined) as 'ok' | 'denied' | 'error' | undefined,
          since: url.searchParams.get('since') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        })
        return this.adminJson(res, 200, { count: rows.length, entries: rows })
      }

      return this.adminJson(res, 404, { error: `Unknown admin endpoint: ${path}` })
    } catch (err) {
      return this.adminJson(res, 500, { error: (err as Error).message })
    }
  }

  private async handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    // ── Existing session ────────────────────────────────────────────────────
    if (sessionId) {
      const session = this.streamableSessions.get(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }))
        return
      }
      const body = req.method === 'POST' ? await this.readBody(req) : undefined
      await session.transport.handleRequest(req, res, body ? JSON.parse(body) as unknown : undefined)
      return
    }

    // ── New session (POST /mcp without session ID = initialize) ────────────
    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing mcp-session-id header' }))
      return
    }

    // Placeholder — filled in by onsessioninitialized
    const session: StreamableSession = {
      sessionId: '',
      agentId: null,
      transport: null as unknown as StreamableHTTPServerTransport,
      mcpServer: null as unknown as McpServer,
      connectedAt: new Date(),
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.sessionId = id
        session.transport = transport
        this.streamableSessions.set(id, session)
        this.allSessions.set(id, session)
        console.log(`[broker] Streamable session opened — ${id}`)
      },
      onsessionclosed: (id) => {
        const s = this.streamableSessions.get(id)
        if (s?.agentId) this.agentRegistry.markOffline(s.agentId)
        this.streamableSessions.delete(id)
        this.allSessions.delete(id)
        console.log(`[broker] Streamable session closed — ${id}`)
      },
    })

    session.transport = transport

    const mcpServer = new McpServer({ name: 'hivemind-broker', version: '0.1.0' })
    session.mcpServer = mcpServer

    this.registerTools(mcpServer, session)
    await mcpServer.connect(transport)

    const body = await this.readBody(req)
    await transport.handleRequest(req, res, body ? JSON.parse(body) as unknown : undefined)
  }

  private async handleSseConnection(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const transport = new SSEServerTransport('/message', res)
    const mcpServer = new McpServer({
      name: 'hivemind-broker',
      version: '0.1.0',
    })

    const session: SseSession = {
      sessionId: transport.sessionId,
      agentId: null,
      transport,
      mcpServer,
      connectedAt: new Date(),
    }

    this.sessions.set(transport.sessionId, session)
    this.allSessions.set(transport.sessionId, session)
    console.log(`[broker] SSE connection opened — session: ${transport.sessionId}`)

    // Register all tools for this session
    this.registerTools(mcpServer, session)

    // Cleanup when client disconnects
    transport.onclose = () => {
      const s = this.sessions.get(transport.sessionId)
      if (s?.agentId) {
        this.agentRegistry.markOffline(s.agentId)
      }
      this.sessions.delete(transport.sessionId)
      this.allSessions.delete(transport.sessionId)
      console.log(`[broker] SSE connection closed — session: ${transport.sessionId}`)
    }

    await mcpServer.connect(transport)
  }

  private async handleMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const sessionId = url.searchParams.get('sessionId')

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing sessionId query parameter' }))
      return
    }

    const session = this.sessions.get(sessionId)
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }))
      return
    }

    await session.transport.handlePostMessage(req, res)
  }

  private registerTools(server: McpServer, session: HiveSession): void {
    registerRegisterTool(server, this.agentRegistry, this.eventQueue, this.allSessions, session, this.auditLedger)
    registerHeartbeatTool(server, this.agentRegistry, this.eventQueue, this.messageBus, this.fileLockRegistry)
    registerWaitTool(server, this.agentRegistry, this.eventQueue, this.messageBus)
    registerSendTool(server, this.agentRegistry, this.messageBus)
    registerListAgentsTool(server, this.agentRegistry)
    registerCreateTaskTool(server, this.agentRegistry, this.taskStore, this.eventQueue, this.auditLedger)
    registerGetNextTaskTool(server, this.agentRegistry, this.taskStore, this.eventQueue)
    registerUpdateTaskProgressTool(server, this.agentRegistry, this.taskStore, this.messageBus)
    registerCompleteTaskTool(server, this.agentRegistry, this.taskStore, this.messageBus, this.auditLedger)
    registerGetTaskTool(server, this.taskStore)
    registerListTasksTool(server, this.taskStore)
    registerDeclareLocksToolTool(server, this.agentRegistry, this.fileLockRegistry, this.eventQueue, this.auditLedger)
    registerRequestLockTool(server, this.agentRegistry, this.fileLockRegistry, this.eventQueue)
    registerReleaseLocksToolTool(server, this.agentRegistry, this.fileLockRegistry, this.eventQueue)
    registerBlackboardReadTool(server, this.agentRegistry, this.blackboard)
    registerBlackboardWriteTool(server, this.agentRegistry, this.blackboard, this.auditLedger)
    registerAuditLogTool(server, this.agentRegistry, this.auditLedger)
    registerGetPendingReviewsTool(server, this.agentRegistry, this.taskStore)
    registerSubmitReviewTool(server, this.agentRegistry, this.taskStore, this.messageBus, this.auditLedger)
    registerEndSessionTool(server, this.agentRegistry, this.blackboard)
    registerMergeBranchTool(server, this.agentRegistry, this.auditLedger)
  }

  start(): void {
    this.httpServer.listen(this.port, () => {
      console.log(`[broker] Listening on http://localhost:${this.port}`)
    })
  }

  stop(): Promise<void> {
    this.messageBus.destroy()
    return new Promise((resolve, reject) => {
      this.httpServer.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
