import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const ROLE_MODEL_DEFAULTS: Record<string, string> = {
  orchestrator: 'claude-opus-4-6',
  architect: 'claude-opus-4-6',
  'coder-backend': 'claude-sonnet-4-6',
  'coder-frontend': 'claude-sonnet-4-6',
  reviewer: 'claude-sonnet-4-6',
  researcher: 'claude-haiku-4-5-20251001',
  devops: 'claude-haiku-4-5-20251001',
}

export interface HiveConfig {
  project: string
  broker: { port: number; transport: string }
  models: Record<string, string>
}

const DEFAULTS: HiveConfig = {
  project: 'unnamed',
  broker: { port: 7432, transport: 'http' },
  models: { ...ROLE_MODEL_DEFAULTS },
}

export function loadConfig(cwd: string = process.cwd()): HiveConfig {
  const configPath = join(cwd, '.hive', 'hive.config.json')
  if (!existsSync(configPath)) return DEFAULTS
  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<HiveConfig>
  return {
    ...DEFAULTS,
    ...parsed,
    broker: { ...DEFAULTS.broker, ...(parsed.broker ?? {}) },
    models: { ...DEFAULTS.models, ...(parsed.models ?? {}) },
  }
}

export function brokerUrl(cwd: string = process.cwd()): string {
  const { broker } = loadConfig(cwd)
  return `http://localhost:${broker.port}`
}
