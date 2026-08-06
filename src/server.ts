/**
 * CLI entry point for claude-tg-plugin.
 *
 * Usage:
 *   bun run src/server.ts
 *   PLUGIN_CONFIG_PATH=/path/to/middleware.config.ts bun run src/server.ts
 *
 * Reads BOT_TOKEN from environment, optionally loads middleware from
 * PLUGIN_CONFIG_PATH. Falls back to empty middleware array if the path
 * is missing, unset, or fails to load.
 */

import { createServer } from './index.ts'
import type { PluginConfig } from './types.ts'

/**
 * Dynamically import middleware config from PLUGIN_CONFIG_PATH.
 * Returns an empty middleware array on any failure.
 */
async function loadConfig(): Promise<Partial<PluginConfig>> {
  const configPath = process.env.PLUGIN_CONFIG_PATH
  if (!configPath) {
    console.log('[tg-plugin] no PLUGIN_CONFIG_PATH, using 0 middleware')
    return { middleware: [] }
  }
  try {
    const mod = await import(configPath)
    const mw = mod.pluginConfig?.middleware ?? mod.middleware ?? []
    console.log(`[tg-plugin] loaded ${mw.length} middleware from ${configPath}`)
    return { middleware: mw }
  } catch (e) {
    console.log(`[tg-plugin] config load failed (${e}), using 0 middleware`)
    return { middleware: [] }
  }
}

const config = await loadConfig()
createServer({
  ...config,
  botToken: process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
  allowedUserIds: [],
  onMessage: async () => {},
}).start()
