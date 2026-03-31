import { spawn } from 'node:child_process'
import { existsSync, openSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import chalk from 'chalk'
import { loadConfig, findProjectRoot } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findBrokerEntry(): string {
  // 1. Monorepo dev layout: cli/dist/commands/ → ../../../broker/dist/index.js
  const devPath = resolve(__dirname, '../../../broker/dist/index.js')
  if (existsSync(devPath)) return devPath

  // 2. Published npm package: @hivemind/broker installed as a dependency
  try {
    const req = createRequire(import.meta.url)
    return req.resolve('@hivemind/broker')
  } catch { /* not installed as a package */ }

  return devPath  // Return anyway so the "not found" error below is clear
}

const BROKER_ENTRY = findBrokerEntry()

export async function runStart(cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd)
  if (!root) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json found. Run ' + chalk.cyan('hive init') + ' first.')
    process.exit(1)
  }
  const pidFile = join(root, '.hive', 'broker.pid')
  const logFile = join(root, '.hive', 'broker.log')
  cwd = root

  // Check if already running
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (isRunning(pid)) {
      const config = loadConfig(cwd)
      console.log(chalk.yellow('⚠') + `  Broker already running (pid ${pid}, port ${config.broker.port})`)
      return
    }
  }

  if (!existsSync(BROKER_ENTRY)) {
    console.error(chalk.red('✖') + `  Broker not found at: ${BROKER_ENTRY}`)
    console.error('   Run ' + chalk.cyan('npm run build') + ' in packages/broker first.')
    process.exit(1)
  }

  const logFd = openSync(logFile, 'a')
  const child = spawn(process.execPath, [BROKER_ENTRY], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  })

  child.unref()

  writeFileSync(pidFile, String(child.pid), 'utf8')

  // Brief pause to let the broker initialise before reporting
  await new Promise(r => setTimeout(r, 400))

  const config = loadConfig(cwd)
  if (isRunning(child.pid!)) {
    console.log(chalk.green('✔') + `  Broker started  pid=${child.pid}  port=${config.broker.port}`)
    console.log('   Logs  → ' + chalk.dim('.hive/broker.log'))
    console.log('')
    console.log('  Next:  ' + chalk.cyan('hive scaffold') + '   — create agent directories')
    console.log('         ' + chalk.cyan('hive status') + '     — check broker & agents')
    console.log('         ' + chalk.cyan('hive stop') + '       — shut down the broker')
  } else {
    console.error(chalk.red('✖') + '  Broker process exited unexpectedly. Check .hive/broker.log for details.')
    process.exit(1)
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
