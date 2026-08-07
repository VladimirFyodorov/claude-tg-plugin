// Public TypeScript interfaces for claude-tg-plugin

import type { Bot, Context } from 'grammy'

// --- Lint types ---

export interface LintResult {
  rule: string
  severity: 'ERROR' | 'WARN'
  message: string
  match?: string
}

export interface LintRule {
  id: string
  severity: 'ERROR' | 'WARN'
  check(method: string, payload: Record<string, unknown>): LintResult[]
}

// --- Config ---

export interface BotCommand {
  command: string
  description: string
}

export interface TgPluginConfig {
  // Required
  botToken: string
  chatId: string

  // HTTP server
  httpPort?: number       // default: 3338
  httpApiKey?: string     // X-TG-Server-Key header auth

  // Access control — if set and non-empty, only deliver messages from these user IDs or chat IDs
  allowedUsers?: string[]

  // Optional modules
  stt?: {
    provider: 'whisper'
    apiKey: string
    language?: string   // default: 'ru'
  }
  persistence?: {
    dbPath?: string     // default: ~/.claude/channels/telegram/history.db
  }
  linter?: {
    rules?: LintRule[]
    mode?: 'soft' | 'hard'    // soft=warn+passthrough, hard=block on ERROR; default: soft
    onViolation?: (violations: LintResult[], method: string) => void
  }

  // Inbound message hook
  onMessage?: (msg: TgMessage) => Promise<void> | void

  // Custom Grammy middleware (applied in order)
  middleware?: Array<(ctx: Context, next: () => Promise<void>) => Promise<void>>

  // Bot commands to register via setMyCommands on polling start
  botCommands?: BotCommand[]

  // Defer polling start until startPolling() is called (for MCP wiring)
  deferStart?: boolean
}

// --- Inbound message ---

export interface TgMessage {
  text: string
  chat_id: string
  user: string
  user_id: string
  message_id: string
  ts: string
  permissionReply?: boolean
  attachment?: {
    kind: 'voice' | 'photo' | 'document' | 'audio' | 'video' | 'sticker'
    file_id: string
    local_path?: string   // set by STT/download middleware
  }
}

// --- Send params ---

export interface SendParams {
  chat_id?: string
  text: string
  priority?: 'INFO' | 'WARN' | 'CRITICAL'   // default: 'INFO'
  format?: 'html' | 'markdownv2' | 'text'
  buttons?: Array<Array<{ text: string; callback_data: string }>>
  reply_to?: number | string
  slug?: string
}

// --- Plugin handle returned by createPlugin ---

export interface TgPlugin {
  send(params: SendParams): Promise<{ message_id: number }>
  setState(mode: 'active' | 'silent'): void
  stop(): Promise<void>
}

export interface TgPluginInternal extends TgPlugin {
  bot: Bot
  pluginState: { mode: 'active' | 'silent' }
  startPolling(onStart?: (info: { username: string }) => void): void
}

// ─── Middleware pipeline API (Phase 2) ────────────────────────────────────────

/**
 * Attachment object passed through the middleware pipeline.
 */
export interface TgAttachment {
  kind: 'voice' | 'photo' | 'document' | 'audio' | 'video' | 'sticker'
  file_id: string
  local_path?: string
}

/**
 * Context object passed to every middleware in the pipeline.
 */
export interface MiddlewareCtx {
  /** Original inbound text (read-only after normalisation) */
  text: string
  /** Outbound text — middlewares may append/replace */
  textOut: string
  chat_id: string
  user: string
  user_id: string
  message_id: string
  /** ISO-8601 timestamp of the inbound message */
  ts: string
  attachment?: TgAttachment
  /** Arbitrary per-request state bag for middleware communication */
  state: Record<string, unknown>
  /** Raw Grammy context object — use for advanced Grammy features */
  grammyCtx: any
}

/**
 * A middleware function in the pipeline (onion/koa style).
 */
export type Middleware = (ctx: MiddlewareCtx, next: () => Promise<void>) => Promise<void>

/**
 * Public configuration for createServer().
 */
export interface PluginConfig {
  /** Telegram bot token */
  botToken: string
  /** Numeric Telegram user IDs allowed to send messages; empty = allow all */
  allowedUserIds: number[]
  /** Called after all middleware complete */
  onMessage: (ctx: MiddlewareCtx) => Promise<void>
  /** User-supplied middleware inserted between linter and deliver stages */
  middleware?: Middleware[]
  /** STT (speech-to-text) stage config */
  stt?: {
    enabled: boolean
    apiKey: string
  }
  /** Linter stage config */
  linter?: {
    rules: LintRule[]
  }
  /** HTTP server port (default: 3338) */
  httpPort?: number
  /** HTTP API key for X-TG-Server-Key header auth */
  httpApiKey?: string
}

/**
 * Server handle returned by createServer().
 */
export interface ServerHandle {
  start(): void
  stop(): Promise<void>
}
