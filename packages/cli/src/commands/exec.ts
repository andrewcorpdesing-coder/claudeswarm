import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { loadConfig, ROLE_MODEL_DEFAULTS } from '../config.js'

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

export async function runExec(
  roleSpecs: string[],
  opts: { launch?: boolean },
  cwd: string = process.cwd(),
): Promise<void> {
  const config = loadConfig(cwd)

  // Build list of { role, model } to show
  let targets: Array<{ role: string; model: string }>

  if (roleSpecs.length === 0) {
    // No roles specified → show all 7 with their configured models
    targets = VALID_ROLES.map(role => ({
      role,
      model: config.models[role] ?? ROLE_MODEL_DEFAULTS[role],
    }))
  } else {
    targets = []
    for (const spec of roleSpecs) {
      const parsed = parseRoleSpec(spec)
      if (!parsed) {
        console.error(chalk.red('✖') + `  Unknown role: ${spec.split(':')[0]}`)
        console.error(`   Valid roles: ${VALID_ROLES.join(', ')}`)
        process.exit(1)
      }
      const model = parsed.modelOverride
        ?? config.models[parsed.role]
        ?? ROLE_MODEL_DEFAULTS[parsed.role]
      targets.push({ role: parsed.role, model })
    }
  }

  // Warn about missing agent directories
  const missing = targets.filter(({ role }) => !existsSync(resolve(cwd, 'agents', role)))
  if (missing.length > 0) {
    console.log(chalk.yellow('⚠') + `  Missing: ${missing.map(r => r.role).join(', ')} — run ${chalk.cyan('hive scaffold')} first`)
    console.log('')
  }

  // Print commands
  console.log(chalk.bold('  Open each in a separate terminal:\n'))
  for (const { role, model } of targets) {
    const dir = `agents/${role}`
    console.log(`  ${chalk.cyan(role.padEnd(18))}  ${chalk.dim('$')} cd ${dir} && claude --model ${model}`)
  }
  console.log('')

  if (opts.launch) {
    await launchAll(targets, cwd)
  } else {
    console.log(chalk.dim('  Tip: add --launch to open terminals automatically (best-effort)'))
  }
}

async function launchAll(
  targets: Array<{ role: string; model: string }>,
  cwd: string,
): Promise<void> {
  console.log(chalk.bold('  Launching terminals...\n'))
  for (const { role, model } of targets) {
    const agentDir = resolve(cwd, 'agents', role)
    if (!existsSync(agentDir)) {
      console.log(chalk.dim(`  skip  ${role} (directory not found)`))
      continue
    }
    const launched = tryLaunch(agentDir, model)
    if (launched) {
      console.log(chalk.green('  ✔') + `  ${role}`)
    } else {
      console.log(chalk.yellow('  ⚠') + `  ${role} — could not open terminal, run manually`)
    }
  }
}

function tryLaunch(agentDir: string, model: string): boolean {
  const claudeCmd = `claude --model ${model}`
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${agentDir}" && ${claudeCmd}`], {
        detached: true, stdio: 'ignore',
      }).unref()
      return true
    }

    if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "cd '${agentDir}' && ${claudeCmd}"`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
      return true
    }

    // Linux — try common terminal emulators in order
    for (const [term, args] of [
      ['gnome-terminal', ['--', 'bash', '-c', `cd "${agentDir}" && ${claudeCmd}; exec bash`]],
      ['konsole',        ['-e', `bash -c 'cd "${agentDir}" && ${claudeCmd}'`]],
      ['xterm',          ['-e', `bash -c 'cd "${agentDir}" && ${claudeCmd}'`]],
    ] as Array<[string, string[]]>) {
      try {
        spawn(term, args, { detached: true, stdio: 'ignore' }).unref()
        return true
      } catch { continue }
    }
    return false
  } catch {
    return false
  }
}
