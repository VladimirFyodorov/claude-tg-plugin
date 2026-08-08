/**
 * claude-tg-plugin — public entry point.
 *
 * Phase 2: createServer(PluginConfig) factory with middleware pipeline.
 *
 * Architecture:
 *   createServer(config) returns { start(), stop() }.
 *   Internally it builds a pipeline:
 *     [sttMiddleware?, linterMiddleware?, ...config.middleware, deliverMiddleware]
 *   and wires it into the existing Grammy-based createPlugin infrastructure.
 */

import { createPlugin } from './plugin.ts'
import { compose, normalizeGrammyCtx } from './middleware.ts'
import type { PluginConfig, ServerHandle, MiddlewareCtx, Middleware } from './types.ts'

// Re-export low-level types for consumers who need them
export type {
  PluginConfig,
  ServerHandle,
  MiddlewareCtx,
  Middleware,
  TgAttachment,
  TgPluginConfig,
  TgPluginInternal,
  TgPlugin,
  TgMessage,
  SendParams,
  LintRule,
  LintResult,
  BotCommand,
} from './types.ts'

export { compose, normalizeGrammyCtx } from './middleware.ts'

export { createMcpChannel } from './mcp/server.ts'
export type { McpChannelHooks, McpChannelOpts, McpChannel } from './mcp/server.ts'
export type { McpToolDef, AccessControlHooks } from './types.ts'

/**
 * Build the middleware pipeline and return a server handle.
 *
 * Pipeline order:
 *   sttMiddleware? → linterMiddleware? → ...config.middleware → deliverMiddleware
 *
 * deliverMiddleware calls config.onMessage(ctx) at the end of the chain.
 */
export function createServer(config: PluginConfig): ServerHandle {
  const stages: Middleware[] = []

  // STT stage — transcribes voice messages when stt.enabled is true.
  // Actual transcription is performed by the Grammy-level makeSttMiddleware
  // hooked into createPlugin below; this stage is a no-op placeholder that
  // keeps the pipeline slot reserved for future pure-pipeline STT.
  if (config.stt?.enabled) {
    const sttStage: Middleware = async (ctx, next) => {
      // Grammy-level STT already ran before this pipeline; forward result.
      await next()
    }
    stages.push(sttStage)
  }

  // Linter stage — runs outbound lint rules against ctx.textOut.
  if (config.linter && config.linter.rules.length > 0) {
    const rules = config.linter.rules
    const linterStage: Middleware = async (ctx, next) => {
      await next()
      // Post-process: check outbound text after downstream middlewares ran
      for (const rule of rules) {
        const violations = rule.check('sendMessage', { text: ctx.textOut })
        if (violations.length > 0) {
          process.stderr.write(
            `tg-plugin linter: ${violations.map(v => `[${v.severity}] ${v.rule}: ${v.message}`).join('; ')}\n`,
          )
        }
      }
    }
    stages.push(linterStage)
  }

  // User-supplied middleware
  if (config.middleware && config.middleware.length > 0) {
    stages.push(...config.middleware)
  }

  // Deliver stage — final handler that calls config.onMessage
  const deliverStage: Middleware = async (ctx) => {
    await config.onMessage(ctx)
  }
  stages.push(deliverStage)

  const pipeline = compose(stages)

  // Build TgPluginConfig for the Grammy-based createPlugin
  const tgConfig = {
    botToken: config.botToken,
    chatId: '',           // not needed when onMessage drives delivery
    httpPort: config.httpPort,
    httpApiKey: config.httpApiKey,
    allowedUsers: config.allowedUserIds.map(String),
    ...(config.stt?.enabled
      ? {
          stt: {
            provider: 'whisper' as const,
            apiKey: config.stt.apiKey,
            language: config.stt.language,
          },
        }
      : {}),
    ...(config.linter
      ? {
          linter: {
            rules: config.linter.rules,
          },
        }
      : {}),
    onMessage: async (msg: any) => {
      // msg is a TgMessage from the Grammy layer; build a MiddlewareCtx and run pipeline
      const ctx: MiddlewareCtx = {
        text: msg.text,
        textOut: '',
        chat_id: msg.chat_id,
        user: msg.user,
        user_id: msg.user_id,
        message_id: msg.message_id,
        ts: msg.ts,
        attachment: msg.attachment,
        state: {},
        grammyCtx: null,  // Grammy ctx not available at this layer
      }
      await pipeline(ctx, async () => {})
    },
  }

  const plugin = createPlugin(tgConfig)

  return {
    start(): void {
      // Grammy bot polling starts inside createPlugin constructor — already running.
      // This method is kept for API symmetry and future use (e.g., deferred start).
      process.stderr.write('tg-plugin: createServer.start() called — polling active\n')
    },
    async stop(): Promise<void> {
      await plugin.stop()
    },
  }
}
