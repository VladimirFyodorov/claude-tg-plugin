/**
 * CLI entry point for claude-tg-plugin.
 *
 * Usage:
 *   bun run src/server.ts
 *   PLUGIN_CONFIG_PATH=/path/to/middleware.config.ts bun run src/server.ts
 *
 * Reads BOT_TOKEN from environment, optionally loads middleware from
 * PLUGIN_CONFIG_PATH (added in Phase 4). Falls back to empty middleware array
 * if the path is missing or unset.
 */

import { createServer } from './index.ts'
import type { PluginConfig, Middleware } from './types.ts'

/**
 * Load base config from environment variables.
 * Middleware loading via PLUGIN_CONFIG_PATH is added in Phase 4.
 */
function loadConfig(): PluginConfig {
  const botToken = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? ''
  if (!botToken) {
    process.stderr.write('tg-plugin: BOT_TOKEN env var is required\n')
    process.exit(1)
  }

  return {
    botToken,
    allowedUserIds: [],
    middleware: [] as Middleware[],
    onMessage: async (_ctx) => {
      // Default handler: no-op. Override via PLUGIN_CONFIG_PATH in Phase 4.
    },
  }
}

const server = createServer(loadConfig())
server.start()
