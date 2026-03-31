import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { TaskStore } from '../agents/TaskStore.js'
import type { MessageBus } from '../mcp/MessageBus.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const Shape = {
  reviewer_id: z.string().min(1),
  task_id: z.string().min(1),
  verdict: z.string().describe('approved | rejected'),
  feedback: z.string().optional().describe('Required when rejecting. Explain what needs to change.'),
}

type Params = {
  reviewer_id: string
  task_id: string
  verdict: string
  feedback?: string
}

export function registerSubmitReviewTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  taskStore: TaskStore,
  messageBus: MessageBus,
  eventQueue: EventQueue,
  auditLedger?: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_submit_review',
    'REVIEWER ONLY. Approve or reject a qa_pending task. ' +
    'On approval: task is marked completed and dependents become unblocked. ' +
    'On rejection: task returns to needs_revision and the agent is notified with feedback.',
    Shape,
    async (params: Params) => {
      try {
        const reviewer = agentRegistry.getById(params.reviewer_id)
        if (!reviewer) return toolErr(`Unknown agent: ${params.reviewer_id}`, 'AGENT_NOT_FOUND')
        if (reviewer.role !== 'reviewer') {
          return toolErr('Only reviewers can submit reviews', 'FORBIDDEN')
        }

        if (params.verdict !== 'approved' && params.verdict !== 'rejected') {
          return toolErr('verdict must be "approved" or "rejected"', 'INVALID_VERDICT')
        }
        if (params.verdict === 'rejected' && !params.feedback?.trim()) {
          return toolErr('feedback is required when rejecting a task', 'FEEDBACK_REQUIRED')
        }

        const task = taskStore.getById(params.task_id)
        if (!task) return toolErr(`Unknown task: ${params.task_id}`, 'TASK_NOT_FOUND')
        if (task.status !== 'qa_pending') {
          return toolErr(
            `Task is not awaiting review (status: ${task.status})`,
            'INVALID_TASK_STATUS',
          )
        }

        if (params.verdict === 'approved') {
          const updated = taskStore.approve({
            taskId: params.task_id,
            reviewerId: params.reviewer_id,
            feedback: params.feedback,
          })

          auditLedger?.log({
            agentId: params.reviewer_id,
            action: 'task_review',
            target: params.task_id,
            detail: { verdict: 'approved' },
            result: 'ok',
          })

          // Notify the agent who did the work
          if (task.assignedTo) {
            messageBus.send({
              fromAgentId: params.reviewer_id,
              toAgentId: task.assignedTo,
              targetIds: [task.assignedTo],
              messageType: 'status_update',
              content: JSON.stringify({
                event: 'task_approved',
                taskId: task.id,
                title: task.title,
                feedback: params.feedback ?? null,
              }),
              priority: 'normal',
            })
          }

          // Notify all orchestrators
          const orchestrators = agentRegistry.getOnline().filter(a => a.role === 'orchestrator')
          for (const orch of orchestrators) {
            messageBus.send({
              fromAgentId: params.reviewer_id,
              toAgentId: orch.id,
              targetIds: [orch.id],
              messageType: 'status_update',
              content: JSON.stringify({
                event: 'task_approved',
                taskId: task.id,
                title: task.title,
                reviewerId: params.reviewer_id,
              }),
              priority: 'normal',
            })
          }

          console.log(`[qa] Approved: ${task.id} by ${params.reviewer_id}`)

          // Notify agents whose tasks just became unblocked
          const unblocked = taskStore.getNewlyUnblockedTasks(params.task_id)
          for (const dep of unblocked) {
            const role = dep.assignedRole
            if (!role) continue
            const targets = agentRegistry.getOnline().filter(a => a.role === role)
            for (const agent of targets) {
              eventQueue.push(agent.id, 'task_available', {
                taskId: dep.id,
                title: dep.title,
                role,
                message: 'A task you can work on is now unblocked. Call hive_get_next_task.',
              })
            }
            console.log(`[qa] task_available pushed for role=${role} (task ${dep.id} unblocked)`)
          }

          // If all tasks are done, push sprint_complete to all agents
          if (taskStore.allCompleted()) {
            const allAgents = agentRegistry.getOnline()
            for (const agent of allAgents) {
              eventQueue.push(agent.id, 'sprint_complete', {
                message: 'All tasks are completed. Call hive_end_session to finish.',
              })
            }
            console.log('[qa] sprint_complete pushed to all agents')
          }

          return toolOk({
            taskId: updated.id,
            status: updated.status,
            verdict: 'approved',
            message: 'Task approved and marked completed.',
          })

        } else {
          // rejected
          const updated = taskStore.reject({
            taskId: params.task_id,
            reviewerId: params.reviewer_id,
            feedback: params.feedback!,
          })

          auditLedger?.log({
            agentId: params.reviewer_id,
            action: 'task_review',
            target: params.task_id,
            detail: { verdict: 'rejected', feedback: params.feedback },
            result: 'ok',
          })

          // Notify the assigned agent with the feedback
          if (task.assignedTo) {
            messageBus.send({
              fromAgentId: params.reviewer_id,
              toAgentId: task.assignedTo,
              targetIds: [task.assignedTo],
              messageType: 'status_update',
              content: JSON.stringify({
                event: 'task_rejected',
                taskId: task.id,
                title: task.title,
                feedback: params.feedback,
                instructions: 'Call hive_get_next_task to pick up your revision task.',
              }),
              priority: 'high',
            })
          }

          // Notify orchestrators
          const orchestrators = agentRegistry.getOnline().filter(a => a.role === 'orchestrator')
          for (const orch of orchestrators) {
            messageBus.send({
              fromAgentId: params.reviewer_id,
              toAgentId: orch.id,
              targetIds: [orch.id],
              messageType: 'status_update',
              content: JSON.stringify({
                event: 'task_rejected',
                taskId: task.id,
                title: task.title,
                reviewerId: params.reviewer_id,
                feedback: params.feedback,
              }),
              priority: 'normal',
            })
          }

          console.log(`[qa] Rejected: ${task.id} by ${params.reviewer_id} — ${params.feedback}`)

          return toolOk({
            taskId: updated.id,
            status: updated.status,
            verdict: 'rejected',
            message: 'Task rejected and returned to agent for revision.',
          })
        }
      } catch (err) {
        return toolErr(`Submit review failed: ${(err as Error).message}`)
      }
    },
  )
}
