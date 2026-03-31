import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { findProjectRoot } from '../config.js'

export async function runStop(cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd)
  const pidFile = join(root ?? cwd, '.hive', 'broker.pid')

  if (!existsSync(pidFile)) {
    console.log(chalk.yellow('⚠') + '  Broker is not running (no .hive/broker.pid found).')
    return
  }

  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  if (isNaN(pid)) {
    console.error(chalk.red('✖') + '  Invalid PID in .hive/broker.pid')
    unlinkSync(pidFile)
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    console.log(chalk.green('✔') + `  SIGTERM sent to broker (pid ${pid})`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      console.log(chalk.yellow('⚠') + `  Process ${pid} not found — was the broker already stopped?`)
    } else {
      throw err
    }
  }

  // Wait for process to exit (up to 3s)
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!isRunning(pid)) break
    await new Promise(r => setTimeout(r, 100))
  }

  if (existsSync(pidFile)) unlinkSync(pidFile)

  if (!isRunning(pid)) {
    console.log(chalk.green('✔') + '  Broker stopped.')
  } else {
    console.log(chalk.yellow('⚠') + `  Broker (pid ${pid}) did not stop within 3s. You may need to kill it manually.`)
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
