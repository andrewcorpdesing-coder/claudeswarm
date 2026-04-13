import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { TaskStore } from '../agents/TaskStore.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const CreateTaskShape = {
  created_by: z.string().min(1).describe('agent_id of the orchestrator creating this task'),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  assigned_role: z.string().optional().describe('Role that should execute: coder-backend | coder-frontend | reviewer | researcher | architect | devops'),
  assigned_to: z.string().optional().describe('Specific agent_id to assign directly'),
  priority: z.number().optional().describe('1=critical 2=high 3=medium 4=low — default: 3'),
  depends_on: z.array(z.string()).optional().describe('task_ids that must be completed first'),
  milestone_id: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  context: z.record(z.unknown()).optional().describe('Additional context the agent will need'),
  task_type: z.enum(['feature','bugfix','refactor','architecture','test','documentation','devops','research'])
    .optional().describe('Type of work — drives priority decay and quality routing'),
  estimated_ms: z.number().int().positive().optional().describe('Estimated duration in milliseconds'),
  estimated_duration_minutes: z.number().int().min(1).optional()
    .describe('Estimated duration in minutes (default: 60). Used for CPM critical path calculation.'),
}

type CreateTaskParams = {
  created_by: string
  title: string
  description: string
  assigned_role?: string
  assigned_to?: string
  priority?: number
  depends_on?: string[]
  milestone_id?: string
  acceptance_criteria?: string
  context?: Record<string, unknown>
  task_type?: string
  estimated_ms?: number
  estimated_duration_minutes?: number
}

export function registerCreateTaskTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  taskStore: TaskStore,
  eventQueue: EventQueue,
  auditLedger?: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_create_task',
    'Create a new task in the system. ORCHESTRATOR ONLY. ' +
    'Supports dependencies (DAG), role assignment, and priority. ' +
    'If assigned_to is set, the agent is notified immediately via pending_events.',
    CreateTaskShape,
    async (params: CreateTaskParams) => {
      try {
        const creator = agentRegistry.getById(params.created_by)
        if (!creator) {
          return toolErr(`Unknown agent: ${params.created_by}`, 'AGENT_NOT_FOUND')
        }
        if (creator.role !== 'orchestrator') {
          return toolErr('Only orchestrators can create tasks', 'FORBIDDEN')
        }

        const priority = params.priority ?? 3
        if (priority < 1 || priority > 4) {
          return toolErr('priority must be 1–4', 'INVALID_PRIORITY')
        }

        const task = taskStore.create({
          title: params.title,
          description: params.description,
          createdBy: params.created_by,
          assignedRole: params.assigned_role,
          assignedTo: params.assigned_to,
          priority,
          milestoneId: params.milestone_id,
          acceptanceCriteria: params.acceptance_criteria,
          dependsOn: params.depends_on,
          context: params.context,
          taskType: params.task_type,
          estimatedMs: params.estimated_ms,
          estimatedDuration: params.estimated_duration_minutes,
        })

        // Notify the directly assigned agent
        if (params.assigned_to) {
          const target = agentRegistry.getById(params.assigned_to)
          if (target) {
            eventQueue.push(params.assigned_to, 'task_assigned', {
              taskId: task.id,
              title: task.title,
              description: task.description,
              priority: task.priority,
              acceptanceCriteria: task.acceptanceCriteria,
              context: task.context,
            })
          }
        }

        auditLedger?.log({
          agentId: params.created_by,
          action: 'task_create',
          target: task.id,
          detail: { title: task.title, priority: task.priority, assignedTo: task.assignedTo },
          result: 'ok',
        })

        console.log(`[tasks] Created: ${task.id} "${task.title}" by ${params.created_by}`)

        return toolOk({
          taskId: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignedTo: task.assignedTo,
          dependsOn: task.dependsOn,
        })
      } catch (err) {
        return toolErr(`Create task failed: ${(err as Error).message}`)
      }
    },
  )
}
