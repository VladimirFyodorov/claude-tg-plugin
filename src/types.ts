// Public TypeScript interfaces for claude-tg-plugin

import type { Context } from 'grammy'

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
