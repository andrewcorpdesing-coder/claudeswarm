import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'

import { ROLE_MODEL_DEFAULTS } from '../config.js'

const DEFAULT_CONFIG = {
  project: 'my-project',
  broker: { port: 7432, transport: 'http' },
  models: { ...ROLE_MODEL_DEFAULTS },
  agents: [],
  qa: { auto_lint: false, auto_test: false, ai_review: false, escalate_threshold: 'high' },
  audit: { deferred: true, trigger_on: ['milestone_complete', 'every_5_tasks'], log_level: 'inter_agent_messages' },
  blackboard: {},
}

export function runInit(projectName: string | undefined, cwd: string = process.cwd()): void {
  const hiveDir = join(cwd, '.hive')
  const configPath = join(hiveDir, 'hive.config.json')
  const gitignorePath = join(hiveDir, '.gitignore')

  if (existsSync(configPath)) {
    console.log(chalk.yellow('⚠  .hive/hive.config.json already exists — skipping.'))
    return
  }

  mkdirSync(hiveDir, { recursive: true })

  const config = { ...DEFAULT_CONFIG, project: projectName ?? DEFAULT_CONFIG.project }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

  // .gitignore for generated files
  writeFileSync(gitignorePath, '*.db\n*.db-wal\n*.db-shm\nbroker.pid\nbroker.log\n', 'utf8')

  // Root .mcp.json — picked up by Claude Code automatically in this directory
  const mcpJsonPath = join(cwd, '.mcp.json')
  if (!existsSync(mcpJsonPath)) {
    const mcpConfig = {
      mcpServers: {
        hivemind: {
          type: 'http',
          url: `http://localhost:${config.broker.port}/mcp`,
        },
      },
    }
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8')
    console.log(chalk.green('✔') + '  Created .mcp.json')
  }

  console.log(chalk.green('✔') + '  Created .hive/')
  console.log(chalk.green('✔') + '  Created .hive/hive.config.json')
  console.log(chalk.green('✔') + '  Created .hive/.gitignore')
  console.log('')
  console.log('  Next steps:')
  console.log('    1. ' + chalk.cyan('hive start') + '         — launch the broker daemon')
  console.log('    2. ' + chalk.cyan('hive scaffold') + '      — create agent directories with prompts & .mcp.json')
  console.log('    3. Open each ' + chalk.cyan('agents/<role>/') + ' in a new Claude Code window')
}
