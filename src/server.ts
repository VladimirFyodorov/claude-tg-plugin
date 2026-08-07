/**
 * CLI entry point for claude-tg-plugin.
 *
 * Usage:
 *   bun run src/server.ts
 *   PLUGIN_CONFIG_PATH=/path/to/config.ts bun run src/server.ts
 *
 * Reads BOT_TOKEN from environment, optionally loads config from
 * PLUGIN_CONFIG_PATH. Starts MCP channel (stdio) + Grammy bot + HTTP server.
 *
 * INVARIANT: no console.log — stdout is JSON-RPC (MCP transport).
 * All logging goes to process.stderr.write.
 */

import { createPlugin } from './plugin.ts'
import { createMcpChannel } from './mcp/server.ts'
import type { TgPluginConfig } from './types.ts'
import type { McpChannelHooks } from './mcp/server.ts'

async function loadConfig(): Promise<Partial<TgPluginConfig> & { mcpHooks?: McpChannelHooks }> {
  const configPath = process.env.PLUGIN_CONFIG_PATH
  if (!configPath) {
    process.stderr.write('[tg-plugin] no PLUGIN_CONFIG_PATH — starting with defaults\n')
    return { middleware: [] }
  }
  try {
    const mod = await import(configPath)
    const cfg = mod.pluginConfig ?? mod.default ?? {}
    const mw = cfg.middleware ?? mod.middleware ?? []
    const botCommands = cfg.botCommands ?? mod.botCommands
    const mcpHooks = cfg.mcpHooks ?? mod.mcpHooks
    process.stderr.write(`[tg-plugin] loaded config from ${configPath} (${mw.length} middleware)\n`)
    return { ...cfg, middleware: mw, botCommands, mcpHooks }
  } catch (e) {
    process.stderr.write(`[tg-plugin] FATAL: config load failed: ${e}\n`)
    process.exit(1)
  }
}

const config = await loadConfig()
const botToken = process.env.BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? ''

if (!botToken) {
  process.stderr.write('[tg-plugin] FATAL: BOT_TOKEN or TELEGRAM_BOT_TOKEN must be set\n')
  process.exit(1)
}

const plugin = createPlugin({
  ...config,
  botToken,
  chatId: config.chatId ?? '',
  allowedUsers: config.allowedUsers ?? [],
  deferStart: true,
  onMessage: async (msg) => {
    mcpChannel.notifyInbound({
      content: msg.text,
      meta: {
        chat_id: msg.chat_id,
        message_id: msg.message_id,
        user: msg.user,
        user_id: msg.user_id,
        ts: msg.ts,
        ...(msg.attachment?.local_path ? { image_path: msg.attachment.local_path } : {}),
        ...(msg.attachment ? {
          attachment_kind: msg.attachment.kind,
          attachment_file_id: msg.attachment.file_id,
        } : {}),
      },
    })
  },
})

const mcpChannel = createMcpChannel({
  bot: plugin.bot,
  botToken,
  inboxDir: config.persistence?.dbPath
    ? undefined
    : undefined,
  hooks: (config as any).mcpHooks,
  pluginState: plugin.pluginState,
})

await mcpChannel.connect()
process.stderr.write('[tg-plugin] MCP connected via stdio\n')

plugin.startPolling()
