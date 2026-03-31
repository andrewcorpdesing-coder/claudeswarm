import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { TaskStore } from '../agents/TaskStore.js'
import type { EventQueue } from '../mcp/EventQueue.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const GetNextTaskShape = {
  agent_id: z.string().min(1),
}

type GetNextTaskParams = {
  agent_id: string
}

export function registerGetNextTaskTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  taskStore: TaskStore,
  eventQueue: EventQueue,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_get_next_task',
    'Claim the next available task matching your role. ' +
    'Call when idle and looking for work. Respects DAG dependencies — ' +
    'only returns tasks whose dependencies are completed.',
    GetNextTaskShape,
    async (params: GetNextTaskParams) => {
      try {
        const agent = agentRegistry.getById(params.agent_id)
        if (!agent) {
          return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
        }
        if (agent.role === 'orchestrator') {
          return toolErr('Orchestrators do not claim tasks — they create and assign them', 'FORBIDDEN')
        }
        if (agent.role === 'reviewer') {
          return toolErr('Reviewers do not claim tasks — use hive_get_pending_reviews and hive_submit_review', 'FORBIDDEN')
        }

        // Check for revision tasks first (agent's own rejected work takes priority)
        const revisionTask = taskStore.getRevisionTask(params.agent_id)
        if (revisionTask) {
          taskStore.startProgress(revisionTask.id)
          console.log(`[tasks] Revision task returned: ${revisionTask.id} → ${params.agent_id}`)
          const verdict = revisionTask.completionSummary  // qa_phase2_verdict stored elsewhere
          return toolOk({
            task: {
              taskId: revisionTask.id,
              title: revisionTask.title,
              description: revisionTask.description,
              priority: revisionTask.priority,
              acceptanceCriteria: revisionTask.acceptanceCriteria,
              context: revisionTask.context,
              dependsOn: revisionTask.dependsOn,
              milestoneId: revisionTask.milestoneId,
              notesForReviewer: revisionTask.notesForReviewer,
            },
            isRevision: true,
          })
        }

        const task = taskStore.getNextAvailable(agent.role)
        if (!task) {
          return toolOk({ task: null, message: 'No pending tasks available for your role' })
        }

        const assigned = taskStore.assign(task.id, params.agent_id)

        // Mark in_progress immediately so the agent can start
        taskStore.startProgress(assigned.id)

        console.log(`[tasks] Assigned: ${assigned.id} → ${params.agent_id}`)

        return toolOk({
          task: {
            taskId: assigned.id,
            title: assigned.title,
            description: assigned.description,
            priority: assigned.priority,
            acceptanceCriteria: assigned.acceptanceCriteria,
            context: assigned.context,
            dependsOn: assigned.dependsOn,
            milestoneId: assigned.milestoneId,
          },
        })
      } catch (err) {
        return toolErr(`Get next task failed: ${(err as Error).message}`)
      }
    },
  )
}
