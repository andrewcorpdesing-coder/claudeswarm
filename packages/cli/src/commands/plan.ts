import chalk from 'chalk'
import { loadConfig, findProjectRoot } from '../config.js'

interface PlanTask { title: string; role: string; depends_on?: string[] }
interface CurrentPlan {
  status?: string
  goal?: string
  scope?: string
  out_of_scope?: string
  files?: string[]
  tasks_draft?: PlanTask[]
  assumptions?: string[]
  created_at?: string
  approved_at?: string
}

export async function runPlan(cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd)
  if (!root) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json found.')
    process.exit(1)
  }
  const config = loadConfig(root)
  const port = config.broker.port

  let res: Response
  try {
    res = await fetch(`http://localhost:${port}/admin/plan`)
  } catch {
    console.error(chalk.red('✖') + '  Broker is not running.')
    process.exit(1)
  }

  const data = await res.json() as { plan: CurrentPlan | null }
  const plan = data.plan

  if (!plan) {
    console.log(chalk.dim('  No plan yet — the orchestrator has not drafted one.'))
    return
  }

  const statusColor = plan.status === 'approved' ? chalk.green
    : plan.status === 'executing' ? chalk.cyan
    : plan.status === 'completed' ? chalk.dim
    : chalk.yellow

  console.log('')
  console.log(chalk.bold('  Current Plan') + '  ' + statusColor(`[${plan.status ?? 'unknown'}]`))
  console.log('')

  if (plan.goal) {
    console.log(chalk.bold('  GOAL'))
    console.log('  ' + plan.goal)
    console.log('')
  }

  if (plan.scope) {
    console.log(chalk.bold('  SCOPE'))
    console.log('  ' + plan.scope)
    console.log('')
  }

  if (plan.out_of_scope) {
    console.log(chalk.bold('  OUT OF SCOPE'))
    console.log('  ' + plan.out_of_scope)
    console.log('')
  }

  if (plan.files?.length) {
    console.log(chalk.bold('  FILES'))
    for (const f of plan.files) console.log('  ' + chalk.dim('→') + ' ' + f)
    console.log('')
  }

  if (plan.tasks_draft?.length) {
    console.log(chalk.bold('  TASKS'))
    plan.tasks_draft.forEach((t, i) => {
      const deps = t.depends_on?.length ? chalk.dim(` (after ${t.depends_on.join(', ')})`) : ''
      console.log(`  ${i + 1}. [${chalk.cyan(t.role)}]  ${t.title}${deps}`)
    })
    console.log('')
  }

  if (plan.assumptions?.length) {
    console.log(chalk.bold('  ASSUMPTIONS'))
    for (const a of plan.assumptions) console.log('  ' + chalk.dim('·') + ' ' + a)
    console.log('')
  }

  if (plan.status === 'draft') {
    console.log(chalk.dim('  Run ') + chalk.cyan('hive approve') + chalk.dim(' to approve, or ') + chalk.cyan('hive reject "feedback"') + chalk.dim(' to request changes.'))
  }
  console.log('')
}

export async function runApprove(cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd)
  if (!root) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json found.')
    process.exit(1)
  }
  const config = loadConfig(root)
  const port = config.broker.port

  let res: Response
  try {
    res = await fetch(`http://localhost:${port}/admin/plan/approve`, { method: 'POST' })
  } catch {
    console.error(chalk.red('✖') + '  Broker is not running.')
    process.exit(1)
  }

  const data = await res.json() as { orchestrators_notified: number }
  console.log(chalk.green('✔') + '  Plan approved')

  if (data.orchestrators_notified > 0) {
    console.log(chalk.dim('   Orchestrator notified — it will start creating tasks now.'))
  } else {
    console.log(chalk.yellow('   ⚠  No orchestrator online — approval queued, will be picked up on next start.'))
  }
}

export async function runReject(feedback: string, cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd)
  if (!root) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json found.')
    process.exit(1)
  }
  const config = loadConfig(root)
  const port = config.broker.port

  let res: Response
  try {
    res = await fetch(`http://localhost:${port}/admin/plan/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    })
  } catch {
    console.error(chalk.red('✖') + '  Broker is not running.')
    process.exit(1)
  }

  const data = await res.json() as { orchestrators_notified: number }
  console.log(chalk.yellow('↩') + '  Plan rejected: ' + chalk.dim(feedback))

  if (data.orchestrators_notified > 0) {
    console.log(chalk.dim('   Orchestrator notified — it will revise the plan.'))
  }
}
