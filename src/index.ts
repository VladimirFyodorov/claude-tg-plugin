/**
 * claude-tg-plugin — public entry point.
 *
 * Phase 1 stub: re-exports createPlugin as createServer.
 * Full createServer(PluginConfig) API + middleware pipeline ships in Phase 2.
 */

export { createPlugin as createServer } from './plugin.ts'
export type { TgPluginConfig, TgPlugin, TgMessage, SendParams, LintRule, LintResult } from './types.ts'
