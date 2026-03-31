import chalk from 'chalk'
import { loadConfig, findProjectRoot } from '../config.js'

export async function runTask(description: string, cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd)
  if (!root) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json found. Run ' + chalk.cyan('hive init') + ' first.')
    process.exit(1)
  }

  const config = loadConfig(root)
  const port = config.broker.port
  const url = `http://localhost:${port}/admin/input`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: description }),
    })
  } catch {
    console.error(chalk.red('✖') + '  Broker is not running. Start with ' + chalk.cyan('hive start') + ' first.')
    process.exit(1)
  }

  if (!res.ok) {
    const body = await res.text()
    console.error(chalk.red('✖') + `  Broker error: ${body}`)
    process.exit(1)
  }

  const data = await res.json() as { orchestrators_notified: number }
  const notified = data.orchestrators_notified ?? 0

  console.log(chalk.green('✔') + '  Task queued: ' + chalk.bold(description))
  if (notified > 0) {
    console.log(chalk.dim(`   Orchestrator notified (${notified} online)`))
  } else {
    console.log(chalk.yellow('   ⚠  No orchestrator online — task will be picked up when one connects'))
  }
}
