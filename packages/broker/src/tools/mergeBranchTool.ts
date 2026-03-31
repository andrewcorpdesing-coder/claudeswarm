import { z } from 'zod'
import { execSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentRegistry } from '../agents/AgentRegistry.js'
import type { AuditLedger } from '../audit/AuditLedger.js'
import { toolOk, toolErr } from '../mcp/toolHelpers.js'

const MergeBranchShape = {
  agent_id: z.string().min(1).describe('Your agent ID (must be orchestrator role)'),
  branch: z
    .string()
    .min(1)
    .describe('Branch to merge into current HEAD — typically "hive/<role>"'),
  task_id: z
    .string()
    .min(1)
    .describe('Task ID being merged — used in the merge commit message'),
  message: z
    .string()
    .optional()
    .describe('Optional extra context for the merge commit message'),
}

type MergeBranchParams = {
  agent_id: string
  branch: string
  task_id: string
  message?: string
}

export function registerMergeBranchTool(
  server: McpServer,
  agentRegistry: AgentRegistry,
  auditLedger?: AuditLedger,
): void {
  ;(server as unknown as { tool: (...a: unknown[]) => void }).tool(
    'hive_merge_branch',
    'Merge an agent\'s hive/<role> branch into the current HEAD branch (typically main/master). ' +
    'Call this after a task is approved by QA. ' +
    'If there are merge conflicts the merge is aborted and the conflicting files are returned. ' +
    'Only orchestrators can call this tool. ' +
    'Requires the project to be a git repository.',
    MergeBranchShape,
    async (params: MergeBranchParams) => {
      const agent = agentRegistry.getById(params.agent_id)
      if (!agent) return toolErr(`Unknown agent: ${params.agent_id}`, 'AGENT_NOT_FOUND')
      if (agent.role !== 'orchestrator') {
        return toolErr('Only orchestrators can call hive_merge_branch', 'FORBIDDEN')
      }

      const cwd = process.cwd()
      const commitMsg = params.message
        ? `Merge ${params.branch} — task ${params.task_id}: ${params.message}`
        : `Merge ${params.branch} — task ${params.task_id}`

      // Verify it's a git repo
      try {
        execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' })
      } catch {
        return toolErr('Not a git repository — branch merging requires git', 'NOT_A_GIT_REPO')
      }

      // Verify the branch exists
      try {
        execSync(`git show-ref --verify --quiet refs/heads/${params.branch}`, { cwd, stdio: 'ignore' })
      } catch {
        return toolErr(`Branch not found: ${params.branch}`, 'BRANCH_NOT_FOUND')
      }

      // Get current branch for the result message
      let currentBranch = 'HEAD'
      try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd }).toString().trim()
      } catch { /* ignore */ }

      // Attempt the merge
      try {
        execSync(`git merge ${params.branch} --no-ff -m "${commitMsg.replace(/"/g, '\\"')}"`, {
          cwd,
          stdio: 'pipe',
        })

        const mergeCommit = execSync('git rev-parse --short HEAD', { cwd }).toString().trim()

        auditLedger?.log({
          agentId: params.agent_id,
          action: 'branch_merge',
          target: params.branch,
          detail: { taskId: params.task_id, into: currentBranch, commit: mergeCommit },
          result: 'ok',
        })

        console.log(`[git] Merged ${params.branch} → ${currentBranch} (${mergeCommit})`)

        return toolOk({
          ok: true,
          merged: params.branch,
          into: currentBranch,
          commit: mergeCommit,
          message: commitMsg,
        })
      } catch (err) {
        // Merge failed — check for conflicts and abort
        let conflictFiles: string[] = []
        try {
          const status = execSync('git diff --name-only --diff-filter=U', { cwd }).toString().trim()
          conflictFiles = status ? status.split('\n').filter(Boolean) : []
        } catch { /* ignore */ }

        // Abort the failed merge to restore clean state
        try {
          execSync('git merge --abort', { cwd, stdio: 'ignore' })
        } catch { /* ignore — might not be in merging state */ }

        const errMsg = (err as { stderr?: Buffer }).stderr?.toString().trim()
          ?? (err as Error).message

        auditLedger?.log({
          agentId: params.agent_id,
          action: 'branch_merge',
          target: params.branch,
          detail: { taskId: params.task_id, into: currentBranch, error: errMsg, conflictFiles },
          result: 'error',
        })

        if (conflictFiles.length > 0) {
          return toolErr(
            `Merge conflict in ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}. ` +
            'Merge was aborted. Resolve conflicts manually or coordinate with the agent to rework.',
            'MERGE_CONFLICT',
          )
        }

        return toolErr(`Merge failed: ${errMsg}`, 'MERGE_FAILED')
      }
    },
  )
}
