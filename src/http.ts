/**
 * HTTP server for claude-tg-plugin.
 *
 * Exposes the same REST API as the embedded tg-server but without any
 * instance-specific concerns: no /inbox endpoint, no orchestrator env vars.
 *
 * All outbound state is accessed via PluginHttpContext.
 */

import { Hono } from 'hono'
import { basename } from 'path'
import type { SendParams } from './types.ts'

export interface PluginHttpContext {
  mode: 'active' | 'silent'
  setMode(m: 'active' | 'silent'): void
  botToken: string
  apiKey: string
  startTime: number
  send(params: SendParams): Promise<{ message_id: number }>
}

// ─── Telegram Bot API helper ─────────────────────────────────────────────────

const TG_API_BASE = 'https://api.telegram.org'

async function tgApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${TG_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as {
    ok: boolean
    result?: unknown
    description?: string
  }
  if (!data.ok)
    throw new Error(`TG API error (${method}): ${data.description ?? 'unknown'}`)
  return data.result
}

// ─── Parse mode resolver ─────────────────────────────────────────────────────

function resolveParseMode(format?: string): string {
  if (!format || format.toLowerCase() === 'html') return 'HTML'
  if (format.toLowerCase() === 'markdownv2') return 'MarkdownV2'
  if (format.toLowerCase() === 'markdown') return 'Markdown'
  return 'HTML'
}

// ─── Notification flag resolver ──────────────────────────────────────────────

// priority → disable_notification mapping per brief Раздел 2
function resolveDisableNotification(
  priority: string,
  mode: 'active' | 'silent',
): boolean {
  if (mode === 'silent') {
    return priority !== 'CRITICAL' // silent: only CRITICAL makes sound
  } else {
    return priority === 'INFO' // active: INFO silent, WARN/CRITICAL with sound
  }
}

// ─── Pending callback registry ───────────────────────────────────────────────

// Track pending callback query auto-answer timeouts (mirrors tg-server behaviour)
const pendingCallbacks = new Map<string, ReturnType<typeof setTimeout>>()

function registerPendingCallback(token: string, callbackQueryId: string): void {
  if (pendingCallbacks.has(callbackQueryId)) return
  const timeout = setTimeout(async () => {
    pendingCallbacks.delete(callbackQueryId)
    await tgApiCall(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
    }).catch(() => {})
  }, 25_000)
  pendingCallbacks.set(callbackQueryId, timeout)
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

function authMiddleware(req: Request, apiKey: string): Response | null {
  if (!apiKey) return null // no key configured → open (dev-only scenario)
  const key = req.headers.get('X-TG-Server-Key')
  if (!key)
    return new Response(
      JSON.stringify({ ok: false, error: 'missing X-TG-Server-Key header' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  if (key !== apiKey)
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid X-TG-Server-Key' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  return null
}

// ─── JSON body parser ─────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ─── Text chunking ───────────────────────────────────────────────────────────

// Defaults kept here; TgPluginConfig can override via textChunkLimit / chunkMode.
export const DEFAULT_CHUNK_LIMIT = 4096
export const DEFAULT_CHUNK_MODE: 'length' | 'newline' = 'length'

export function chunk(
  text: string,
  limit: number = DEFAULT_CHUNK_LIMIT,
  mode: 'length' | 'newline' = DEFAULT_CHUNK_MODE,
): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut =
        para > limit / 2
          ? para
          : line > limit / 2
            ? line
            : space > 0
              ? space
              : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ─── HTTP server factory ──────────────────────────────────────────────────────

type ButtonRow = Array<{ text: string; data?: string; callback_data?: string }>

export function createHttpServer(
  port: number,
  ctx: PluginHttpContext,
): { server: ReturnType<typeof Bun.serve>; stop(): void } {
  const app = new Hono()

  // GET /health
  app.get('/health', async (c) => {
    let bot_username: string | null = null
    let token_valid = false
    try {
      const res = await fetch(`${TG_API_BASE}/bot${ctx.botToken}/getMe`)
      const json = (await res.json()) as {
        ok: boolean
        result?: { username?: string }
      }
      token_valid = json.ok === true
      bot_username = json.result?.username ? `@${json.result.username}` : null
    } catch {
      token_valid = false
    }
    return c.json({
      ok: true,
      port,
      bot_username,
      token_valid,
      auth_ok: !!ctx.apiKey && token_valid,
      mode: ctx.mode,
      http_port: port,
      uptime_s: Math.floor((Date.now() - ctx.startTime) / 1000),
    })
  })

  // GET /state
  app.get('/state', (c) => {
    return c.json({
      mode: ctx.mode,
      uptime_s: Math.floor((Date.now() - ctx.startTime) / 1000),
    })
  })

  // POST /state
  app.post('/state', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    const body = await parseJsonBody(c.req.raw)
    const mode = body.mode as string
    if (mode !== 'silent' && mode !== 'active') {
      return c.json(
        { ok: false, error: `invalid mode "${mode}" — must be "silent" or "active"` },
        400,
      )
    }
    ctx.setMode(mode as 'silent' | 'active')
    return c.json({ ok: true, mode: ctx.mode })
  })

  // POST /send — unified send endpoint with priority + format + reply_to + buttons
  // No notify_orchestrator / slug / synthetic-inbox writes
  app.post('/send', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      const chat_id = String(body.chat_id ?? '')
      const text = String(body.text ?? '')
      const priority = String(body.priority ?? 'INFO').toUpperCase()
      const format = body.format as string | undefined
      const reply_to = body.reply_to
      const rawButtons = body.buttons as ButtonRow[] | undefined

      if (!chat_id || !text) {
        return c.json({ ok: false, error: 'chat_id and text are required' }, 400)
      }

      const disableNotification = resolveDisableNotification(priority, ctx.mode)

      const tgBody: Record<string, unknown> = {
        chat_id,
        text,
        parse_mode: resolveParseMode(format),
        disable_notification: disableNotification,
      }
      if (reply_to !== undefined && reply_to !== '') {
        tgBody.reply_parameters = { message_id: Number(reply_to) }
      }
      if (rawButtons && rawButtons.length > 0) {
        tgBody.reply_markup = {
          inline_keyboard: rawButtons.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              callback_data: btn.callback_data ?? btn.data ?? '',
            })),
          ),
        }
      }

      const result = (await tgApiCall(
        ctx.botToken,
        'sendMessage',
        tgBody,
      )) as { message_id: number }
      return c.json({
        ok: true,
        message_id: result.message_id,
        last_send: { disable_notification: disableNotification },
      })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /reply — backward-compat alias for /send
  app.post('/reply', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      const chat_id = String(body.chat_id ?? '')
      const text = String(body.text ?? '')
      const format = body.format as string | undefined
      const reply_to = body.reply_to
      const rawButtons = body.buttons as ButtonRow[] | undefined

      if (!chat_id || !text) {
        return c.json({ ok: false, error: 'chat_id and text are required' }, 400)
      }

      const tgBody: Record<string, unknown> = {
        chat_id,
        text,
        parse_mode: resolveParseMode(format),
      }
      if (reply_to !== undefined && reply_to !== '') {
        tgBody.reply_parameters = { message_id: Number(reply_to) }
      }
      if (rawButtons && rawButtons.length > 0) {
        tgBody.reply_markup = {
          inline_keyboard: rawButtons.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              callback_data: btn.callback_data ?? btn.data ?? '',
            })),
          ),
        }
      }

      const result = (await tgApiCall(
        ctx.botToken,
        'sendMessage',
        tgBody,
      )) as { message_id: number }
      return c.json({ ok: true, message_id: result.message_id })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /react
  app.post('/react', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      await tgApiCall(ctx.botToken, 'setMessageReaction', {
        chat_id: body.chat_id,
        message_id: Number(body.message_id),
        reaction: [{ type: 'emoji', emoji: body.emoji }],
      })
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /edit
  app.post('/edit', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      await tgApiCall(ctx.botToken, 'editMessageText', {
        chat_id: body.chat_id,
        message_id: Number(body.message_id),
        text: body.text,
      })
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /edit-reply-markup
  app.post('/edit-reply-markup', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      const rows = (
        body.buttons as Array<
          Array<{ text: string; data?: string; callback_data?: string }>
        >
      ).map((row) =>
        row.map((btn) => ({
          text: btn.text,
          callback_data: btn.callback_data ?? btn.data ?? '',
        })),
      )
      await tgApiCall(ctx.botToken, 'editMessageReplyMarkup', {
        chat_id: body.chat_id,
        message_id: Number(body.message_id),
        reply_markup: { inline_keyboard: rows },
      })
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /send-file
  app.post('/send-file', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      const chat_id = String(body.chat_id ?? '')
      const file_path = String(body.file_path ?? '')
      const caption = body.caption as string | undefined

      const ext = file_path.split('.').pop()?.toLowerCase() ?? ''
      let method: string
      let field: string
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        method = 'sendPhoto'
        field = 'photo'
      } else if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) {
        method = 'sendVideo'
        field = 'video'
      } else if (['ogg', 'oga'].includes(ext)) {
        method = 'sendVoice'
        field = 'voice'
      } else {
        method = 'sendDocument'
        field = 'document'
      }

      const fileData = Bun.file(file_path)
      const form = new FormData()
      form.append('chat_id', chat_id)
      form.append(field, fileData, basename(file_path))
      if (caption) form.append('caption', caption)
      if (method === 'sendVideo') form.append('supports_streaming', 'true')

      const res = await fetch(`${TG_API_BASE}/bot${ctx.botToken}/${method}`, {
        method: 'POST',
        body: form,
      })
      const data = (await res.json()) as {
        ok: boolean
        result?: { message_id: number }
        description?: string
      }
      if (!data.ok)
        throw new Error(`TG API error (${method}): ${data.description ?? 'unknown'}`)
      return c.json({ ok: true, message_id: data.result!.message_id })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /send-chat-action
  app.post('/send-chat-action', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      await tgApiCall(ctx.botToken, 'sendChatAction', {
        chat_id: body.chat_id,
        action: body.action,
      })
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /register-callback
  app.post('/register-callback', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      registerPendingCallback(
        ctx.botToken,
        String(body.callback_query_id ?? ''),
      )
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  // POST /answer-callback
  app.post('/answer-callback', async (c) => {
    const authResp = authMiddleware(c.req.raw, ctx.apiKey)
    if (authResp) return authResp
    try {
      const body = await parseJsonBody(c.req.raw)
      const { callback_query_id, edit_text, chat_id, message_id, buttons } =
        body as {
          callback_query_id: string
          edit_text?: string
          chat_id?: string | number
          message_id?: string | number
          buttons?: ButtonRow[]
        }
      // Cancel auto-answer timeout if present
      const existingTimeout = pendingCallbacks.get(callback_query_id)
      if (existingTimeout) {
        clearTimeout(existingTimeout)
        pendingCallbacks.delete(callback_query_id)
      }
      // Dismiss native button spinner
      await tgApiCall(ctx.botToken, 'answerCallbackQuery', { callback_query_id })
      // Optionally update the message
      if (
        edit_text !== undefined &&
        chat_id !== undefined &&
        message_id !== undefined
      ) {
        const editBody: Record<string, unknown> = {
          chat_id,
          message_id: Number(message_id),
          text: edit_text,
        }
        if (buttons && buttons.length > 0) {
          editBody.reply_markup = {
            inline_keyboard: buttons.map((row) =>
              row.map((btn) => ({
                text: btn.text,
                callback_data: btn.callback_data ?? btn.data ?? '',
              })),
            ),
          }
        }
        await tgApiCall(ctx.botToken, 'editMessageText', editBody)
      }
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502)
    }
  })

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    error(err) {
      process.stderr.write(`tg-plugin HTTP server error: ${err}\n`)
      return new Response(
        JSON.stringify({ ok: false, error: String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  return {
    server,
    stop() {
      server.stop(true)
    },
  }
}
