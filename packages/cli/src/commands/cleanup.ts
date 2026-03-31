import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import chalk from 'chalk'

const BLACKBOARD_DEFAULT = JSON.stringify({
  project: { meta: {}, architecture: {}, conventions: {} },
  knowledge: { discoveries: [], warnings: [], external_apis: {}, session_log: [] },
  state: { sprint: null, blockers: [], milestones: {} },
  agents: {},
  qa: { findings: [], metrics: {}, pending_review: [] },
}, null, 2) + '\n'

function isRunning(pidFile: string): boolean {
  try {
    if (!existsSync(pidFile)) return false
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' })
    return true
  } catch { return false }
}

export function runCleanup(
  opts: { db?: boolean; blackboard?: boolean; branches?: boolean; all?: boolean },
  cwd: string = process.cwd(),
): void {
  const hiveDir = join(cwd, '.hive')

  if (!existsSync(join(hiveDir, 'hive.config.json'))) {
    console.error(chalk.red('✖') + '  No .hive/hive.config.json — run hive init first.')
    process.exit(1)
  }

  // Default: all if no flags given
  const cleanDb = opts.db || opts.all || (!opts.db && !opts.blackboard && !opts.branches)
  const cleanBb = opts.blackboard || opts.all || (!opts.db && !opts.blackboard && !opts.branches)
  const cleanBranches = opts.branches || opts.all

  // Warn if broker is running and we're touching the DB
  const pidFile = join(hiveDir, 'broker.pid')
  if (cleanDb && isRunning(pidFile)) {
    console.log(chalk.yellow('⚠') + '  Broker is running — stop it first with ' + chalk.cyan('hive stop') + ' before cleaning the database.')
    process.exit(1)
  }

  let cleaned = 0

  if (cleanDb) {
    const dbPath = join(hiveDir, 'tasks.db')
    const walPath = dbPath + '-wal'
    const shmPath = dbPath + '-shm'
    for (const p of [dbPath, walPath, shmPath]) {
      if (existsSync(p)) { unlinkSync(p); cleaned++ }
    }
    console.log(chalk.green('✔') + '  Removed .hive/tasks.db  (all tasks, agents, locks, audit log)')
  }

  if (cleanBb) {
    const bbPath = join(hiveDir, 'blackboard.json')
    writeFileSync(bbPath, BLACKBOARD_DEFAULT, 'utf8')
    cleaned++
    console.log(chalk.green('✔') + '  Reset .hive/blackboard.json  (all shared state cleared)')
  }

  if (cleanBranches) {
    if (!isGitRepo(cwd)) {
      console.log(chalk.dim('  (not a git repo — skipping branch cleanup)'))
    } else {
      let branchOutput = ''
      try {
        branchOutput = execSync('git branch --list "hive/*"', { cwd }).toString().trim()
      } catch { /* ignore */ }

      const branches = branchOutput
        .split('\n')
        .map(b => b.replace(/^\*?\s+/, '').trim())
        .filter(Boolean)

      if (branches.length === 0) {
        console.log(chalk.dim('  (no hive/* branches to delete)'))
      } else {
        for (const branch of branches) {
          try {
            execSync(`git branch -D ${branch}`, { cwd, stdio: 'ignore' })
            console.log(chalk.green('✔') + `  Deleted branch ${chalk.cyan(branch)}`)
            cleaned++
          } catch {
            console.log(chalk.yellow('⚠') + `  Could not delete ${branch} (may be checked out)`)
          }
        }
      }
    }
  }

  if (cleaned === 0) {
    console.log(chalk.dim('  Nothing to clean.'))
  } else {
    console.log('')
    console.log(chalk.dim('  Run hive start to launch a fresh broker session.'))
  }
}
