/**
 * createPlugin — main entry point for claude-tg-plugin.
 *
 * Assembles Grammy bot, inbound handlers, outbound linter middleware,
 * optional persistence, optional STT, HTTP server, and graceful shutdown.
 *
 * No MCP SDK, no hardcoded instance paths, no orchestrator env var reads.
 */

import { Bot, GrammyError, InputFile } from 'grammy'
import type { Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, extname } from 'path'
import { randomBytes } from 'crypto'

import type { TgPluginConfig, TgPlugin, TgPluginInternal, TgMessage, SendParams } from './types.ts'
import { builtinRules, createLintChecker } from './linter.ts'
import { initDb, persistMessage } from './persistence.ts'
import { makeSttMiddleware } from './stt.ts'
import { createHttpServer } from './http.ts'
import type { PluginHttpContext } from './http.ts'
import { chunk, DEFAULT_CHUNK_LIMIT, DEFAULT_CHUNK_MODE } from './http.ts'
import type { Database } from 'bun:sqlite'

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else goes as documents (raw file, no compression).
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// Default persistence directory
const DEFAULT_DB_DIR = join(homedir(), '.claude', 'channels', 'telegram')

// Default temp dir for STT downloads
const DEFAULT_STT_INBOX = join(homedir(), '.claude', 'channels', 'telegram', 'inbox')

// Filenames and titles are uploader-controlled. Strip delimiter chars to avoid
// tag attribute injection in downstream log formatting.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

/**
 * Create the Telegram plugin.
 *
 * With deferStart: true, polling does not begin until startPolling() is called.
 * This allows wiring MCP before the bot starts receiving messages.
 *
 * @param config - Plugin configuration object
 * @returns TgPluginInternal handle with bot, send, setState, stop, startPolling
 */
export function createPlugin(config: TgPluginConfig): TgPluginInternal {
  // ─── Grammy bot ──────────────────────────────────────────────────────────────
  const bot = new Bot(config.botToken)

  // Track bot username (set on successful polling start)
  let botUsername = ''

  // ─── Outbound linter middleware ──────────────────────────────────────────────
  const lintChecker = createLintChecker(
    config.linter?.rules ?? builtinRules,
    config.linter?.mode ?? 'soft',
    config.linter?.onViolation,
  )

  bot.api.config.use(async (prev, method, payload, signal) => {
    lintChecker(method, payload as Record<string, unknown>)
    return prev(method, payload, signal)
  })

  // ─── Plugin state ─────────────────────────────────────────────────────────────
  const pluginState: { mode: 'active' | 'silent' } = { mode: 'active' }
  const startTime = Date.now()

  // ─── Persistence ─────────────────────────────────────────────────────────────
  let db: Database | undefined
  if (config.persistence) {
    db = initDb(config.persistence.dbPath ?? DEFAULT_DB_DIR)
  }

  // ─── STT inbox dir ───────────────────────────────────────────────────────────
  const sttInboxDir = DEFAULT_STT_INBOX

  // ─── send() implementation ────────────────────────────────────────────────────
  const defaultChatId = config.chatId

  async function send(params: SendParams): Promise<{ message_id: number }> {
    const chat_id = params.chat_id ?? defaultChatId
    const text = params.text
    const priority = (params.priority ?? 'INFO').toUpperCase()
    const format = params.format

    function resolveParseMode(fmt?: string): 'HTML' | 'MarkdownV2' | 'Markdown' | undefined {
      if (!fmt || fmt.toLowerCase() === 'html') return 'HTML'
      if (fmt.toLowerCase() === 'markdownv2') return 'MarkdownV2'
      if (fmt.toLowerCase() === 'markdown') return 'Markdown'
      return 'HTML'
    }

    function resolveDisableNotification(prio: string, mode: 'active' | 'silent'): boolean {
      if (mode === 'silent') return prio !== 'CRITICAL'
      return prio === 'INFO'
    }

    const disableNotification = resolveDisableNotification(priority, pluginState.mode)
    const parseMode = resolveParseMode(format)

    const chunks = chunk(text, DEFAULT_CHUNK_LIMIT, DEFAULT_CHUNK_MODE)
    // replyToMode: 'first' sends reply_parameters only on the first chunk.
    // Kept as a config-extensible field; currently always 'first'.
    const reply_to = params.reply_to != null ? Number(params.reply_to) : undefined

    let lastMessageId = 0

    for (let i = 0; i < chunks.length; i++) {
      // 'first' mode: only the first chunk carries reply_parameters
      const shouldReplyTo = reply_to != null && i === 0

      const tgBody: Record<string, unknown> = {
        chat_id,
        text: chunks[i],
        parse_mode: parseMode,
        disable_notification: disableNotification,
      }
      if (shouldReplyTo) {
        tgBody.reply_parameters = { message_id: reply_to }
      }
      if (params.buttons && params.buttons.length > 0 && i === 0) {
        tgBody.reply_markup = {
          inline_keyboard: params.buttons.map(row =>
            row.map(btn => ({ text: btn.text, callback_data: btn.callback_data })),
          ),
        }
      }

      const sent = await bot.api.sendMessage(chat_id, chunks[i], {
        parse_mode: parseMode,
        disable_notification: disableNotification,
        ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to! } } : {}),
        ...(params.buttons && params.buttons.length > 0 && i === 0
          ? {
              reply_markup: {
                inline_keyboard: params.buttons.map(row =>
                  row.map(btn => ({ text: btn.text, callback_data: btn.callback_data })),
                ),
              },
            }
          : {}),
      })
      lastMessageId = sent.message_id
    }

    return { message_id: lastMessageId }
  }

  // ─── allowedUsers gate helper ─────────────────────────────────────────────────
  function isAllowed(ctx: Context): boolean {
    if (!config.allowedUsers || config.allowedUsers.length === 0) return true
    const from = ctx.from
    if (!from) return false
    const userId = String(from.id)
    const username = from.username ? `@${from.username}` : undefined
    return (
      config.allowedUsers.includes(userId) ||
      (username != null && config.allowedUsers.includes(username)) ||
      (from.username != null && config.allowedUsers.includes(from.username))
    )
  }

  // ─── Inbound message delivery ─────────────────────────────────────────────────

  type AttachmentMeta = {
    kind: 'voice' | 'voice_text' | 'photo' | 'document' | 'audio' | 'video' | 'video_note' | 'sticker'
    file_id: string
    size?: number
    mime?: string
    name?: string
  }

  async function handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    // Persist before access gate — every message is saved unconditionally
    if (db) {
      persistMessage(db, ctx)
    }

    // Access gate
    if (!isAllowed(ctx)) return

    const from = ctx.from!
    const chat_id = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Permission-reply intercept
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      const request_id = permMatch[2]!.toLowerCase()
      const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
      if (config.onMessage) {
        await config.onMessage({
          text,
          chat_id,
          user: from.username ?? String(from.id),
          user_id: String(from.id),
          message_id: String(msgId ?? ''),
          ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
          permissionReply: true,
        })
      }
      // React with checkmark or cross
      if (msgId != null) {
        const emoji = behavior === 'allow' ? '✅' : '❌'
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return
    }

    // Typing indicator
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

    const imagePath = downloadImage ? await downloadImage() : undefined

    if (config.onMessage) {
      // Normalise internal kind (voice_text, video_note) to TgMessage attachment kinds
      const normaliseKind = (k?: string): TgMessage['attachment'] extends { kind: infer K } | undefined ? K : never => {
        if (k === 'voice_text') return 'voice' as any
        if (k === 'video_note') return 'video' as any
        return (k ?? 'photo') as any
      }

      const tgMsg: TgMessage = {
        text,
        chat_id,
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        message_id: String(msgId ?? ''),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(attachment || imagePath
          ? {
              attachment: {
                kind: normaliseKind(attachment?.kind),
                file_id: attachment?.file_id ?? '',
                local_path: imagePath,
              },
            }
          : {}),
      }
      await config.onMessage(tgMsg)
    }
  }

  // ─── STT middleware ───────────────────────────────────────────────────────────
  if (config.stt) {
    bot.use(
      makeSttMiddleware({
        token: config.botToken,
        inboxDir: sttInboxDir,
        apiKey: config.stt.apiKey,
        language: config.stt.language,
      }),
    )
  }

  // ─── MiddlewareCtx adapter ────────────────────────────────────────────────────
  // Consumer middleware expects MiddlewareCtx shape (ctx.state, ctx.text, etc.)
  // but Grammy Context doesn't have these fields. This adapter bridges the two.
  if (config.middleware && config.middleware.length > 0) {
    bot.use(async (ctx, next) => {
      const c = ctx as any
      c.state = c.state ?? {}
      if (ctx.message) {
        c.text = c.text ?? ctx.message.text ?? (ctx.message as any).caption ?? ''
        c.textOut = c.textOut ?? c.text
        c.user = ctx.from?.username ?? String(ctx.from?.id ?? '')
        c.user_id = String(ctx.from?.id ?? '')
        c.chat_id = String(ctx.chat?.id ?? '')
        c.message_id = String(ctx.message.message_id ?? '')
        c.ts = new Date((ctx.message.date ?? 0) * 1000).toISOString()
        c.grammyCtx = ctx
      }
      await next()
    })
    for (const mw of config.middleware) {
      bot.use(mw)
    }
  }

  // ─── Message handlers ─────────────────────────────────────────────────────────

  bot.on('message:text', async ctx => {
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  bot.on('message:photo', async ctx => {
    const caption = ctx.message.caption ?? '(photo)'
    await handleInbound(ctx, caption, async () => {
      const photos = ctx.message.photo
      const best = photos[photos.length - 1]
      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) return undefined
        const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const inboxDir = sttInboxDir
        mkdirSync(inboxDir, { recursive: true })
        const path = join(inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
        writeFileSync(path, buf)
        return path
      } catch (err) {
        process.stderr.write(`tg-plugin: photo download failed: ${err}\n`)
        return undefined
      }
    })
  })

  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'document',
      file_id: doc.file_id,
      size: doc.file_size,
      mime: doc.mime_type,
      name,
    })
  })

  bot.on('message:voice', async ctx => {
    const voice = ctx.message.voice
    const stt = (ctx as any)._stt as { text: string } | undefined
    const text = stt?.text ?? ctx.message.caption ?? '(voice message)'
    const kind = stt ? 'voice_text' : 'voice'
    await handleInbound(ctx, text, undefined, {
      kind,
      file_id: voice.file_id,
      size: voice.file_size,
      mime: voice.mime_type,
    })
  })

  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'audio',
      file_id: audio.file_id,
      size: audio.file_size,
      mime: audio.mime_type,
      name,
    })
  })

  bot.on('message:video', async ctx => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined, {
      kind: 'video',
      file_id: video.file_id,
      size: video.file_size,
      mime: video.mime_type,
      name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', async ctx => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, '(video note)', undefined, {
      kind: 'video_note',
      file_id: vn.file_id,
      size: vn.file_size,
    })
  })

  bot.on('message:sticker', async ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
      kind: 'sticker',
      file_id: sticker.file_id,
      size: sticker.file_size,
    })
  })

  // ─── Grammy error handler — keeps polling on handler errors ──────────────────
  bot.catch(err => {
    process.stderr.write(`tg-plugin: handler error (polling continues): ${err.error}\n`)
  })

  // ─── HTTP server ──────────────────────────────────────────────────────────────
  const httpCtx: PluginHttpContext = {
    get mode() { return pluginState.mode },
    setMode(m) { pluginState.mode = m },
    botToken: config.botToken,
    apiKey: config.httpApiKey ?? '',
    startTime,
    send,
  }

  const httpServer = createHttpServer(config.httpPort ?? 3338, httpCtx)
  process.stderr.write(`tg-plugin: HTTP server listening on port ${config.httpPort ?? 3338}\n`)

  // ─── Polling with retry backoff ───────────────────────────────────────────────
  let shuttingDown = false

  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write('tg-plugin: shutting down\n')
    httpServer.stop()
    setTimeout(() => process.exit(0), 2000)
    void Promise.resolve(bot.stop()).finally(() => {
      if (db) {
        try { db.close() } catch {}
      }
      process.exit(0)
    })
  }

  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', shutdown)

  // Unhandled rejection / exception safety net
  process.on('unhandledRejection', err => {
    process.stderr.write(`tg-plugin: unhandled rejection: ${err}\n`)
  })
  process.on('uncaughtException', err => {
    process.stderr.write(`tg-plugin: uncaught exception: ${err}\n`)
  })

  // ─── Polling with retry backoff ────────────────────────────────────────────────
  function doStartPolling(onStart?: (info: { username: string }) => void): void {
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await bot.start({
            onStart: info => {
              attempt = 0
              botUsername = info.username
              process.stderr.write(`tg-plugin: polling as @${info.username}\n`)
              if (config.botCommands && config.botCommands.length > 0) {
                void bot.api.setMyCommands(config.botCommands, { scope: { type: 'all_private_chats' } }).catch(() => {})
              }
              onStart?.(info)
            },
          })
          return
        } catch (err) {
          if (shuttingDown) return
          if (err instanceof Error && err.message === 'Aborted delay') return
          const is409 = err instanceof GrammyError && err.error_code === 409
          if (is409 && attempt >= 8) {
            process.stderr.write(
              `tg-plugin: 409 Conflict persists after ${attempt} attempts — ` +
              `another poller is holding the bot token. Exiting.\n`,
            )
            return
          }
          const delay = Math.min(1000 * attempt, 15000)
          const detail = is409
            ? `409 Conflict${attempt === 1 ? ' — another instance is polling?' : ''}`
            : `polling error: ${err}`
          process.stderr.write(`tg-plugin: ${detail}, retrying in ${delay / 1000}s\n`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    })()
  }

  if (!config.deferStart) {
    doStartPolling()
  }

  // ─── Return TgPluginInternal ──────────────────────────────────────────────────
  return {
    bot,
    pluginState,
    send,
    setState(mode: 'active' | 'silent'): void {
      pluginState.mode = mode
    },
    startPolling(onStart?: (info: { username: string }) => void): void {
      doStartPolling(onStart)
    },
    async stop(): Promise<void> {
      shutdown()
    },
  }
}
