#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runStart } from './commands/start.js'
import { runStop } from './commands/stop.js'
import { runStatus, runAgents, runTasks } from './commands/status.js'
import { runPrompt, runScaffold } from './commands/prompt.js'
import { runExec } from './commands/exec.js'
import { runCleanup } from './commands/cleanup.js'
import { runRun } from './commands/run.js'
import { runTask } from './commands/task.js'
import { runPlan, runApprove, runReject } from './commands/plan.js'

const program = new Command()

program
  .name('hiveclaude')
  .description('HiveClaude — coordinador de agentes Claude Code')
  .version('0.1.0')

// ── hive init ──────────────────────────────────────────────────────────────
program
  .command('init [project-name]')
  .description('Initialize .hive/ config in the current directory')
  .action((projectName: string | undefined) => {
    runInit(projectName)
  })

// ── hive start ─────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the Hive Mind broker as a background daemon')
  .action(async () => {
    await runStart()
  })

// ── hive stop ──────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the running broker daemon')
  .action(async () => {
    await runStop()
  })

// ── hive status ────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show broker status and online agent count')
  .action(async () => {
    await runStatus()
  })

// ── hive agents ────────────────────────────────────────────────────────────
program
  .command('agents')
  .description('List online agents')
  .action(async () => {
    await runAgents()
  })

// ── hive tasks ─────────────────────────────────────────────────────────────
program
  .command('tasks')
  .description('List tasks')
  .option('-s, --status <status>', 'Filter by status (pending|in_progress|qa_pending|completed…)')
  .action(async (opts: { status?: string }) => {
    await runTasks(opts.status)
  })

// ── hive prompt ────────────────────────────────────────────────────────────
program
  .command('prompt <role>')
  .description('Print the system prompt for a given agent role')
  .option('-i, --agent-id <id>', 'Agent ID to embed in the prompt (default: <role>-1)')
  .option('-o, --output <path>', 'Write the prompt to a file instead of stdout')
  .action(async (role: string, opts: { agentId?: string; output?: string }) => {
    await runPrompt(role, opts.agentId, opts.output)
  })

// ── hive scaffold ──────────────────────────────────────────────────────────
program
  .command('scaffold')
  .description('Create agents/ directory with CLAUDE.md stubs for each role')
  .option('--force', 'Overwrite existing CLAUDE.md files (re-embed latest prompts)')
  .action(async (opts: { force?: boolean }) => {
    await runScaffold(process.cwd(), opts)
  })

// ── hive exec ──────────────────────────────────────────────────────────────
program
  .command('exec [roles...]')
  .description('Print commands (or launch terminals) to start agent sessions')
  .option('--launch', 'Attempt to open a new terminal window for each role (best-effort)')
  .option('--yolo', 'Add --dangerously-skip-permissions to each claude command')
  .addHelpText('after', `
Examples:
  hiveclaude exec                                   # show all 7 roles
  hiveclaude exec orchestrator coder-backend        # show only these roles
  hiveclaude exec orchestrator:opus coder-backend:sonnet  # override model per role
  hiveclaude exec --launch orchestrator coder-backend reviewer  # open terminals
  hiveclaude exec --launch --yolo orchestrator coder-backend reviewer  # skip permission prompts`)
  .action(async (roles: string[], opts: { launch?: boolean; yolo?: boolean }) => {
    await runExec(roles, opts)
  })

// ── hive run ───────────────────────────────────────────────────────────────
program
  .command('run [task]')
  .description('Start broker (if needed), queue a task, and launch all agents in one command')
  .option('--roles <roles...>', 'Roles to launch (default: orchestrator coder-backend coder-frontend reviewer)')
  .option('--yolo', 'Add --dangerously-skip-permissions to each claude command')
  .addHelpText('after', `
Examples:
  hiveclaude run                                         # launch default 4 agents, no task
  hiveclaude run "implementa autenticación JWT"           # queue task + launch agents
  hiveclaude run --yolo "agrega endpoint DELETE /users"  # skip permission prompts
  hiveclaude run --roles orchestrator coder-backend "implementa la API"`)
  .action(async (task: string | undefined, opts: { roles?: string[]; yolo?: boolean }) => {
    await runRun(task, opts.roles ?? [], opts)
  })

// ── hive task ──────────────────────────────────────────────────────────────
program
  .command('task <description>')
  .description('Queue a task for the running orchestrator without restarting agents')
  .action(async (description: string) => {
    await runTask(description)
  })

// ── hive plan ──────────────────────────────────────────────────────────────
program
  .command('plan')
  .description('Show the orchestrator\'s current plan (draft or approved)')
  .action(async () => { await runPlan() })

// ── hive approve ───────────────────────────────────────────────────────────
program
  .command('approve')
  .description('Approve the current plan — orchestrator will start creating tasks')
  .action(async () => { await runApprove() })

// ── hive reject ────────────────────────────────────────────────────────────
program
  .command('reject <feedback>')
  .description('Reject the current plan with feedback — orchestrator will revise it')
  .action(async (feedback: string) => { await runReject(feedback) })

// ── hive restart ───────────────────────────────────────────────────────────
program
  .command('restart')
  .description('Stop the broker, clean state, and start fresh')
  .option('--keep-blackboard', 'Preserve the blackboard (only reset DB)')
  .action(async (opts: { keepBlackboard?: boolean }) => {
    const { runStop } = await import('./commands/stop.js')
    const { runCleanup } = await import('./commands/cleanup.js')
    const { runStart } = await import('./commands/start.js')
    await runStop()
    runCleanup({ db: true, blackboard: !opts.keepBlackboard })
    await runStart()
  })

// ── hive cleanup ───────────────────────────────────────────────────────────
program
  .command('cleanup')
  .description('Reset broker state: remove tasks.db and reset blackboard (broker must be stopped)')
  .option('--db',         'Remove only .hive/tasks.db (tasks, agents, locks, audit)')
  .option('--blackboard', 'Reset only .hive/blackboard.json to defaults')
  .option('--branches',   'Delete all hive/* git branches')
  .option('--all',        'Clean everything: db + blackboard + branches')
  .action((opts: { db?: boolean; blackboard?: boolean; branches?: boolean; all?: boolean }) => {
    runCleanup(opts)
  })

program.parse()
