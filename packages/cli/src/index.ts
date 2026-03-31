#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runStart } from './commands/start.js'
import { runStop } from './commands/stop.js'
import { runStatus, runAgents, runTasks } from './commands/status.js'
import { runPrompt, runScaffold } from './commands/prompt.js'
import { runExec } from './commands/exec.js'

const program = new Command()

program
  .name('hive')
  .description('Hive Mind — coordinador de agentes Claude Code')
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
  .action(async () => {
    await runScaffold()
  })

// ── hive exec ──────────────────────────────────────────────────────────────
program
  .command('exec [roles...]')
  .description('Print commands (or launch terminals) to start agent sessions')
  .option('--launch', 'Attempt to open a new terminal window for each role (best-effort)')
  .addHelpText('after', `
Examples:
  hive exec                                   # show all 7 roles
  hive exec orchestrator coder-backend        # show only these roles
  hive exec orchestrator:opus coder-backend:sonnet  # override model per role
  hive exec --launch orchestrator coder-backend reviewer  # open terminals`)
  .action(async (roles: string[], opts: { launch?: boolean }) => {
    await runExec(roles, opts)
  })

program.parse()
