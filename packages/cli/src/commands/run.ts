import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { loadConfig, findProjectRoot, ROLE_MODEL_DEFAULTS } from '../config.js'
import { runStart } from './start.js'
import { runTask } from './task.js'

const VALID_ROLES = [
  'orchestrator', 'coder-backend', 'coder-frontend',
  'reviewer', 'researcher', 'architect', 'devops',
]

const MODEL_SHORTHANDS: Record<string, string> = {
  opus:   'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
}

function resolveModel(s: string): string {
  return MODEL_SHORTHANDS[s] ?? s
}

function parseRoleSpec(spec: string): { role: string; modelOverride: string | null } | null {
  const colonIdx = spec.indexOf(':')
  const role = colonIdx >= 0 ? spec.slice(0, colonIdx) : spec
  const modelPart = colonIdx >= 0 ? spec.slice(colonIdx + 1) : null
  if (!VALID_ROLES.includes(role)) return null
  return { role, modelOverride: modelPart ? resolveModel(modelPart) : null }
}

export async function runRun(
  taskDescription: string | undefined,
  roleSpecs: string[],
  opts: { yolo?: boolean; layout?: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const root = findProjectRoot(cwd)
  if (!root) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json found. Run ' + chalk.cyan('hive init') + ' first.')
    process.exit(1)
  }

  const config = loadConfig(root)
  const port = config.broker.port
  const skipPerms = opts.yolo ? ' --dangerously-skip-permissions' : ''

  // ── 1. Ensure broker is running ───────────────────────────────────────────
  const brokerOnline = await checkBroker(port)
  if (!brokerOnline) {
    console.log(chalk.dim('  Broker not running — starting...'))
    await runStart(root)
    // Brief pause for broker to fully initialise
    await new Promise(r => setTimeout(r, 300))
  }

  // ── 2. Queue task if provided ─────────────────────────────────────────────
  if (taskDescription?.trim()) {
    await runTask(taskDescription.trim(), root)
  }

  // ── 3. Build targets list ─────────────────────────────────────────────────
  let targets: Array<{ role: string; model: string }>

  if (roleSpecs.length === 0) {
    // Default: orchestrator + backend + frontend + reviewer
    const defaultRoles = ['orchestrator', 'coder-backend', 'coder-frontend', 'reviewer']
    targets = defaultRoles.map(role => ({
      role,
      model: config.models[role] ?? ROLE_MODEL_DEFAULTS[role],
    }))
  } else {
    targets = []
    for (const spec of roleSpecs) {
      const parsed = parseRoleSpec(spec)
      if (!parsed) {
        console.error(chalk.red('✖') + `  Unknown role: ${spec.split(':')[0]}`)
        process.exit(1)
      }
      const model = parsed.modelOverride ?? config.models[parsed.role] ?? ROLE_MODEL_DEFAULTS[parsed.role]
      targets.push({ role: parsed.role, model })
    }
  }

  // Warn about missing agent directories
  const missing = targets.filter(({ role }) => !existsSync(resolve(root, 'agents', role)))
  if (missing.length > 0) {
    console.log(chalk.yellow('⚠') + `  Missing agent dirs: ${missing.map(r => r.role).join(', ')} — run ${chalk.cyan('hive scaffold')} first`)
    process.exit(1)
  }

  // ── 4. Launch in Windows Terminal panes ───────────────────────────────────
  console.log(chalk.bold('\n  Launching agents...\n'))
  const launched = launchPanes(targets, root, skipPerms)

  if (!launched) {
    // Fallback: individual windows
    for (const { role, model } of targets) {
      const agentDir = resolve(root, 'agents', role)
      const cmd = `claude --model ${model}${skipPerms}`
      try {
        spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${agentDir}" && ${cmd}`], {
          detached: true, stdio: 'ignore',
        }).unref()
        console.log(chalk.green('  ✔') + `  ${role}`)
      } catch {
        console.log(chalk.yellow('  ⚠') + `  ${role} — open manually: cd agents/${role} && ${cmd}`)
      }
    }
  }

  console.log('')
  if (taskDescription?.trim()) {
    console.log(chalk.dim('  Task queued. The orchestrator will pick it up on startup.'))
  }
  console.log(chalk.dim('  Monitor → http://localhost:' + port + '/monitor'))
}

// ── Windows Terminal panes layout ─────────────────────────────────────────────

function launchPanes(
  targets: Array<{ role: string; model: string }>,
  root: string,
  skipPerms: string,
): boolean {
  if (process.platform !== 'win32') return false

  const agentCmd = (role: string, model: string) => {
    const dir = resolve(root, 'agents', role)
    return `claude --model ${model}${skipPerms}`
  }

  const agentDir = (role: string) => resolve(root, 'agents', role)

  try {
    if (targets.length === 1) {
      const { role, model } = targets[0]
      spawn('wt', [
        'new-tab', '--title', role, '-d', agentDir(role),
        'cmd', '/k', agentCmd(role, model),
      ], { detached: true, stdio: 'ignore' }).unref()
      return true
    }

    if (targets.length === 2) {
      const [a, b] = targets
      spawn('wt', [
        'new-tab', '--title', a.role, '-d', agentDir(a.role), 'cmd', '/k', agentCmd(a.role, a.model), ';',
        'split-pane', '-V', '--title', b.role, '-d', agentDir(b.role), 'cmd', '/k', agentCmd(b.role, b.model),
      ], { detached: true, stdio: 'ignore' }).unref()
      return true
    }

    if (targets.length === 3) {
      const [a, b, c] = targets
      spawn('wt', [
        'new-tab', '--title', a.role, '-d', agentDir(a.role), 'cmd', '/k', agentCmd(a.role, a.model), ';',
        'split-pane', '-V', '--title', b.role, '-d', agentDir(b.role), 'cmd', '/k', agentCmd(b.role, b.model), ';',
        'split-pane', '-H', '--title', c.role, '-d', agentDir(c.role), 'cmd', '/k', agentCmd(c.role, c.model),
      ], { detached: true, stdio: 'ignore' }).unref()
      return true
    }

    // 4+ agents: quad layout (2x2 for first 4, remaining as tabs)
    const [a, b, c, d, ...rest] = targets
    const wtArgs = [
      'new-tab', '--title', a.role, '-d', agentDir(a.role), 'cmd', '/k', agentCmd(a.role, a.model), ';',
      'split-pane', '-V', '--title', b.role, '-d', agentDir(b.role), 'cmd', '/k', agentCmd(b.role, b.model), ';',
      'move-focus', 'left', ';',
      'split-pane', '-H', '--title', c.role, '-d', agentDir(c.role), 'cmd', '/k', agentCmd(c.role, c.model), ';',
      'move-focus', 'right', ';',
      'split-pane', '-H', '--title', d.role, '-d', agentDir(d.role), 'cmd', '/k', agentCmd(d.role, d.model),
    ]

    for (const extra of rest) {
      wtArgs.push(';', 'new-tab', '--title', extra.role, '-d', agentDir(extra.role), 'cmd', '/k', agentCmd(extra.role, extra.model))
    }

    spawn('wt', wtArgs, { detached: true, stdio: 'ignore' }).unref()
    console.log(chalk.green('  ✔') + `  ${targets.length} panes opened in Windows Terminal`)
    return true
  } catch {
    return false
  }
}

async function checkBroker(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/ping`)
    return res.ok
  } catch {
    return false
  }
}
